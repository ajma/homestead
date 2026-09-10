import type { FastifyInstance } from "fastify";
import { inScope, requireAuth } from "../auth/context.js";
import type { PersistedTransition } from "../monitoring/persist.js";
import { sseResponse } from "../sse.js";

/**
 * The fan-out point between the scheduler and every open browser tab.
 *
 * Kept separate from the scheduler so the route does not reach into it, and so a test can
 * publish a transition without running a tick.
 */
export class EventBus {
  private readonly subscribers = new Set<(t: PersistedTransition) => void>();
  private readonly closers = new Set<() => void>();

  /**
   * `onClose` is separate from the transition channel on purpose. Pushing a sentinel
   * value through `subscribe` would make every subscriber type-check for something that
   * is not a transition, to serve one test affordance.
   */
  subscribe(listener: (t: PersistedTransition) => void, onClose?: () => void): () => void {
    this.subscribers.add(listener);
    if (onClose) this.closers.add(onClose);
    return () => {
      this.subscribers.delete(listener);
      if (onClose) this.closers.delete(onClose);
    };
  }

  publish(transition: PersistedTransition): void {
    // Transitions only. Emitting every sample would put one message per probe per
    // interval on every open tab, for a status that did not change.
    if (!transition.changed) return;
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(transition);
      } catch {
        // One tab's failure is not another's.
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Ends every open stream. A test affordance today — `inject` buffers a response and
   * cannot settle while a stream is open — and the hook a graceful shutdown will call.
   */
  closeAll(): void {
    for (const close of [...this.closers]) close();
  }
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  const { events } = app.deps;

  app.get("/api/events", async (request, reply) => {
    // Deliberately `requireAuth`, not a capability: this is the only monitoring route a
    // viewer may open, and it is how their launcher updates.
    const ctx = requireAuth(request);

    const sse = sseResponse(request, reply);
    let done: (() => void) | null = null;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });

    const unsubscribe = events.subscribe(
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

    try {
      await finished;
    } finally {
      unsubscribe();
      sse.close();
    }
  });
}
