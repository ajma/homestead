import type { PersistedTransition } from "@server/monitoring/persist";
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
});
