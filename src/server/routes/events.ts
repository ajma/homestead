import type { FastifyInstance } from "fastify";
import { inScope, requireAuth } from "../auth/context.js";
import type { PersistedTransition } from "../monitoring/persist.js";
import { sseResponse } from "../sse.js";

/**
 * Backstop for the lifetime cap on `/api/events`, below. `AuthContext` is resolved once
 * at connect time and never refreshed for the life of the stream — see the cap's comment
 * on the route. Named so the number itself, and the reason it is not larger or smaller,
 * live in one place.
 */
const MAX_STREAM_MS = 15 * 60_000;

/**
 * The rate limiter on every route (300/min per IP) bounds request *rate*, not concurrent
 * stream *count*: measured, one viewer opened 40 of 40 attempted `/api/events` streams,
 * leaving 80 live timers (a heartbeat and a lifetime cap per stream), each living up to
 * `MAX_STREAM_MS`. Five covers phone, laptop, desktop and a couple of stray tabs without
 * letting one client accumulate an unbounded number of open sockets and timers.
 */
const MAX_STREAMS_PER_USER = 5;

type Subscription = {
  userId: string;
  listener: (t: PersistedTransition) => void;
  onClose?: () => void;
};

/**
 * The fan-out point between the scheduler and every open browser tab.
 *
 * Kept separate from the scheduler so the route does not reach into it, and so a test can
 * publish a transition without running a tick.
 */
export class EventBus {
  private readonly subscriptions = new Set<Subscription>();

  /**
   * `maxStreamMs` defaults to `MAX_STREAM_MS`; a test overrides it the same way the
   * scheduler's `now`/`random` are overridden — an optional constructor field rather than
   * a second, parallel configuration mechanism.
   */
  constructor(private readonly opts: { maxStreamMs?: number } = {}) {}

  get maxStreamMs(): number {
    return this.opts.maxStreamMs ?? MAX_STREAM_MS;
  }

  /**
   * `onClose` is separate from the transition channel on purpose. Pushing a sentinel
   * value through `subscribe` would make every subscriber type-check for something that
   * is not a transition, to serve one test affordance.
   */
  subscribe(
    userId: string,
    listener: (t: PersistedTransition) => void,
    onClose?: () => void,
  ): () => void {
    const subscription: Subscription = { userId, listener, onClose };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  publish(transition: PersistedTransition): void {
    // Transitions only. Emitting every sample would put one message per probe per
    // interval on every open tab, for a status that did not change.
    if (!transition.changed) return;
    for (const subscription of [...this.subscriptions]) {
      try {
        subscription.listener(transition);
      } catch {
        // One tab's failure is not another's.
      }
    }
  }

  subscriberCount(): number {
    return this.subscriptions.size;
  }

  /** How many open streams `userId` currently holds. The route checks this against
   * `MAX_STREAMS_PER_USER` before subscribing — reusing this Set rather than adding a
   * second registry that could drift from it. */
  countForUser(userId: string): number {
    let count = 0;
    for (const subscription of this.subscriptions) {
      if (subscription.userId === userId) count++;
    }
    return count;
  }

  /**
   * Ends every open stream. A test affordance today — `inject` buffers a response and
   * cannot settle while a stream is open — and the hook a graceful shutdown will call.
   */
  closeAll(): void {
    for (const subscription of [...this.subscriptions]) subscription.onClose?.();
  }

  /**
   * Ends only the streams belonging to `userId`, and nothing else. Called after a user's
   * role, scope, or account is changed, so a revoked or narrowed viewer's tab reconnects
   * and re-resolves its `AuthContext` instead of continuing to evaluate `inScope` against
   * a stale snapshot.
   */
  closeForUser(userId: string): void {
    for (const subscription of [...this.subscriptions]) {
      if (subscription.userId !== userId) continue;
      try {
        subscription.onClose?.();
      } catch {
        // One stream's failure to close is not another's.
      }
    }
  }
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  const { events } = app.deps;

  app.get("/api/events", async (request, reply) => {
    // Deliberately `requireAuth`, not a capability: this is the only monitoring route a
    // viewer may open, and it is how their launcher updates.
    const ctx = requireAuth(request);

    // Checked, and the reply sent, BEFORE `sseResponse` hijacks it — a hijacked reply is
    // never returned from a handler, so the cap has to be enforced on the ordinary
    // Fastify response path. Refusing a 6th stream rather than closing the oldest: it
    // keeps every open tab's connection stable, and it is the caller's own choice which
    // tab to close to get back under the cap.
    if (events.countForUser(ctx.userId) >= MAX_STREAMS_PER_USER) {
      return reply.code(429).send({ error: "too_many_streams" });
    }

    const sse = sseResponse(request, reply);
    let done: (() => void) | null = null;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });

    const unsubscribe = events.subscribe(
      ctx.userId,
      (transition) => {
        // The scope predicate, applied per event. A scoped viewer must not learn that an
        // app they cannot see exists, let alone that it just went down.
        if (!inScope(ctx, transition.appId)) return;
        sse.send("status", {
          appId: transition.appId,
          probeId: transition.probeId,
          status: transition.status,
          faultClass: transition.faultClass,
        });
      },
      () => done?.(),
    );

    void sse.closed.then(() => done?.());

    // The lifetime cap: the backstop for any path that changes what this user may see
    // without going through the three routes that call `closeForUser`. Forcing a
    // reconnect here re-runs `preHandler`, which re-resolves `AuthContext` from current
    // data instead of the snapshot this stream was opened with.
    const capTimer = setTimeout(() => done?.(), events.maxStreamMs);

    try {
      await finished;
    } finally {
      clearTimeout(capTimer);
      unsubscribe();
      sse.close();
    }
  });
}
