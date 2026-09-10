import { request } from "node:http";
import type { PersistedTransition } from "@server/monitoring/persist";
import { EventBus } from "@server/routes/events";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

const CONFIG = JSON.stringify({ name: "jellyfin", services: { web: { image: "nginx" } } });

async function withApp() {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
  app.deps.host.composeResults.set("config --format json", {
    exitCode: 0,
    stdout: CONFIG,
    stderr: "",
  });
  const adopted = await app.inject({
    method: "POST",
    url: "/api/apps/adopt",
    headers: { cookie },
    payload: { directories: ["jellyfin"] },
  });
  return { app, cookie, id: adopted.json().adopted[0].id as string };
}

const transition = (
  appId: string,
  over: Partial<PersistedTransition> = {},
): PersistedTransition => ({
  probeId: "p1",
  appId,
  status: "down",
  faultClass: "app",
  changed: true,
  ...over,
});

/** Opens the stream, emits, then closes it so `inject` can settle. */
async function collect(
  app: Awaited<ReturnType<typeof withApp>>["app"],
  cookie: string,
  emit: () => void,
) {
  const streaming = app.inject({ method: "GET", url: "/api/events", headers: { cookie } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  emit();
  await new Promise((resolve) => setTimeout(resolve, 20));
  app.deps.scheduler.stop();
  app.deps.events.closeAll();
  return streaming;
}

describe("/api/events", () => {
  it("emits a transition to an admin", async () => {
    const { app, cookie, id } = await withApp();
    const res = await collect(app, cookie, () => app.deps.events.publish(transition(id)));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: status");
    expect(JSON.parse(res.body.match(/event: status\ndata: (.*)/)?.[1] ?? "{}")).toMatchObject({
      appId: id,
      probeId: "p1",
      status: "down",
      faultClass: "app",
    });
    await app.close();
  });

  it("is open to a viewer — this is how their launcher updates", async () => {
    const { app, cookie, id } = await withApp();
    const viewer = await createViewer(app, cookie);
    const res = await collect(app, viewer.cookie, () => app.deps.events.publish(transition(id)));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: status");
    await app.close();
  });

  it("does not send a scoped viewer events for apps they cannot see", async () => {
    // The scope predicate is the security boundary here, applied per event rather than
    // per query.
    const { app, cookie, id } = await withApp();
    const scoped = await createViewer(app, cookie, { scopeAllApps: false, appIds: [] });
    const res = await collect(app, scoped.cookie, () => app.deps.events.publish(transition(id)));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("event: status");
    expect(res.body).not.toContain(id);
    await app.close();
  });

  it("never emits a non-transition", async () => {
    // "Transitions only" is what keeps one EventSource from carrying a message per probe
    // per interval for every app.
    const { app, cookie, id } = await withApp();
    const res = await collect(app, cookie, () =>
      app.deps.events.publish(transition(id, { changed: false })),
    );
    expect(res.body).not.toContain("event: status");
    await app.close();
  });

  it("refuses an anonymous client", async () => {
    const { app } = await withApp();
    expect((await app.inject({ method: "GET", url: "/api/events" })).statusCode).toBe(401);
    await app.close();
  });

  it("unsubscribes when the client disconnects", async () => {
    const { app, cookie, id } = await withApp();
    await collect(app, cookie, () => app.deps.events.publish(transition(id)));
    // The bus must not retain a listener per closed tab.
    expect(app.deps.events.subscriberCount()).toBe(0);
    await app.close();
  });

  it("clears the lifetime-cap timer when the stream ends before the cap fires", async () => {
    // Mutation testing analogue: gutting the cap's `clearTimeout` leaves every test above
    // green, because none of them run long enough to observe the cap firing. Without it,
    // every closed stream leaks a Timeout scheduled up to MAX_STREAM_MS in the future —
    // one per abandoned tab, for the life of the process.
    const { app, cookie, id } = await withApp();
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    await collect(app, cookie, () => app.deps.events.publish(transition(id)));
    expect(timers()).toBe(before);
    await app.close();
  });

  it("closes a stream once its lifetime cap elapses", async () => {
    // A small injected cap stands in for the real 15-minute one — see MAX_STREAM_MS in
    // events.ts. This is the backstop: no mutation route runs here, nothing calls
    // `closeForUser` or `closeAll`, only the cap itself ends the stream.
    const app = await buildTestApp({ maxStreamMs: 30 });
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({ method: "GET", url: "/api/events", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(app.deps.events.subscriberCount()).toBe(0);
    await app.close();
  });

  it("unsubscribes on a real socket disconnect, not just after inject's mock socket settles", async () => {
    // app.inject() runs on light-my-request's mock socket: app.close() alone never fires
    // `close` on request.raw/reply.raw, so this path was previously verified by
    // inspection only. A listening server plus a real node:http client closes the actual
    // gap.
    const { app, cookie } = await withApp();
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a bound TCP address");
      }

      const waitUntil = async (predicate: () => boolean) => {
        const deadline = Date.now() + 2000;
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error("timed out waiting for condition");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };

      const req = request({
        host: "127.0.0.1",
        port: address.port,
        path: "/api/events",
        method: "GET",
        headers: { cookie },
      });
      req.end();
      await new Promise<void>((resolve, reject) => {
        req.on("response", (res) => {
          res.resume();
          resolve();
        });
        req.on("error", reject);
      });

      await waitUntil(() => app.deps.events.subscriberCount() === 1);
      req.destroy();
      await waitUntil(() => app.deps.events.subscriberCount() === 0);
    } finally {
      await app.close();
    }
  });
});

describe("EventBus.closeForUser", () => {
  it("ends only the named user's streams", () => {
    const bus = new EventBus();
    let closedB = false;
    // Each `onClose` calls its own `unsubscribe`, mirroring what the route's `finally`
    // does once `onClose` resolves its `finished` promise.
    const unsubA = bus.subscribe(
      "user-a",
      () => {},
      () => unsubA(),
    );
    const unsubB = bus.subscribe(
      "user-b",
      () => {},
      () => {
        closedB = true;
        unsubB();
      },
    );

    bus.closeForUser("user-a");

    expect(closedB).toBe(false);
    expect(bus.subscriberCount()).toBe(1);
  });
});

describe("closing a user's stream when their access changes", () => {
  function openStream(app: Awaited<ReturnType<typeof withApp>>["app"], cookie: string) {
    return app.inject({ method: "GET", url: "/api/events", headers: { cookie } });
  }

  it("closes an open stream when PATCH changes that user's role", async () => {
    const { app, cookie } = await withApp();
    const viewer = await createViewer(app, cookie);
    const streaming = openStream(app, viewer.cookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.deps.events.subscriberCount()).toBe(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/users/${viewer.id}`,
      headers: { cookie },
      payload: { role: "admin" },
    });
    expect(patched.statusCode).toBe(200);

    const res = await streaming;
    expect(res.statusCode).toBe(200);
    expect(app.deps.events.subscriberCount()).toBe(0);
    await app.close();
  });

  it("closes an open stream when PATCH narrows that user's scopeAllApps", async () => {
    // scopeAllApps is also settable through PATCH, not only through PUT .../scope. This
    // is the same boundary as the PUT test below, reached through the other route.
    const { app, cookie } = await withApp();
    const viewer = await createViewer(app, cookie);
    const streaming = openStream(app, viewer.cookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.deps.events.subscriberCount()).toBe(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/users/${viewer.id}`,
      headers: { cookie },
      payload: { scopeAllApps: false },
    });
    expect(patched.statusCode).toBe(200);

    const res = await streaming;
    expect(res.statusCode).toBe(200);
    expect(app.deps.events.subscriberCount()).toBe(0);
    await app.close();
  });

  it("closes an open stream when PATCH disables that user", async () => {
    // preHandler already 401s a disabled user's new requests (app.ts). Without this, an
    // already-open stream is the one place that lockout does not reach: it never
    // re-enters preHandler, so a disabled housemate keeps a live status feed regardless.
    const { app, cookie } = await withApp();
    const viewer = await createViewer(app, cookie);
    const streaming = openStream(app, viewer.cookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.deps.events.subscriberCount()).toBe(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/users/${viewer.id}`,
      headers: { cookie },
      payload: { disabled: true },
    });
    expect(patched.statusCode).toBe(200);

    const res = await streaming;
    expect(res.statusCode).toBe(200);
    expect(app.deps.events.subscriberCount()).toBe(0);
    await app.close();
  });

  it("does not close a stream over a name-only PATCH", async () => {
    // The negative case: nothing AuthContext is evaluated against changed, so the stream
    // must survive the edit and keep delivering events. Without this, a later "simplify"
    // could close on every PATCH and reconnect every open tab on a rename.
    const { app, cookie, id } = await withApp();
    const viewer = await createViewer(app, cookie);
    const streaming = openStream(app, viewer.cookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.deps.events.subscriberCount()).toBe(1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/users/${viewer.id}`,
      headers: { cookie },
      payload: { name: "Renamed" },
    });
    expect(patched.statusCode).toBe(200);
    expect(app.deps.events.subscriberCount()).toBe(1);

    app.deps.events.publish(transition(id));
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.deps.scheduler.stop();
    app.deps.events.closeAll();
    const res = await streaming;
    expect(res.body).toContain("event: status");
    await app.close();
  });

  it("closes an open stream when an admin narrows that user's scope", async () => {
    const { app, cookie } = await withApp();
    const viewer = await createViewer(app, cookie);
    const streaming = openStream(app, viewer.cookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.deps.events.subscriberCount()).toBe(1);

    const scoped = await app.inject({
      method: "PUT",
      url: `/api/users/${viewer.id}/scope`,
      headers: { cookie },
      payload: { scopeAllApps: false, appIds: [] },
    });
    expect(scoped.statusCode).toBe(200);

    const res = await streaming;
    expect(res.statusCode).toBe(200);
    expect(app.deps.events.subscriberCount()).toBe(0);
    await app.close();
  });

  it("closes an open stream when an admin deletes that user", async () => {
    const { app, cookie } = await withApp();
    const viewer = await createViewer(app, cookie);
    const streaming = openStream(app, viewer.cookie);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.deps.events.subscriberCount()).toBe(1);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/users/${viewer.id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(204);

    const res = await streaming;
    expect(res.statusCode).toBe(200);
    expect(app.deps.events.subscriberCount()).toBe(0);
    await app.close();
  });
});
