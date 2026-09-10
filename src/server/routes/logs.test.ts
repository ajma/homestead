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
  app.deps.host.containers = [
    {
      id: "container-1",
      names: ["jellyfin-web-1"],
      image: "nginx",
      state: "running",
      status: "Up 2 hours",
      project: "jellyfin",
      service: "web",
      labels: {},
    },
  ];
  const adopted = await app.inject({
    method: "POST",
    url: "/api/apps/adopt",
    headers: { cookie },
    payload: { directories: ["jellyfin"] },
  });
  return { app, cookie, id: adopted.json().adopted[0].id as string };
}

describe("log streaming", () => {
  it("streams lines as separate events, tagged by stream", async () => {
    const { app, cookie, id } = await withApp();
    app.deps.host.logLines.set("container-1", [
      { text: "listening on 8096\n", stream: "stdout" },
      { text: "permission denied\n", stream: "stderr" },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/container-1/logs`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body.match(/event: line/g)).toHaveLength(2);
    expect(res.body).toContain('"stream":"stderr"');
    expect(res.body).toContain("permission denied");
    await app.close();
  });

  it("refuses a container that belongs to a different app", async () => {
    // Otherwise the container id is a handle to anything on the host, including a
    // container from an app this caller cannot see.
    const { app, cookie, id } = await withApp();
    app.deps.host.containers.push({
      id: "other-1",
      names: ["paperless-web-1"],
      image: "x",
      state: "running",
      status: "Up",
      project: "paperless",
      service: "web",
      labels: {},
    });
    app.deps.host.logLines.set("other-1", [{ text: "secret\n", stream: "stdout" }]);
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/other-1/logs`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("secret");
    await app.close();
  });

  it("refuses a viewer", async () => {
    const { app, cookie, id } = await withApp();
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/container-1/logs`,
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("passes tail and follow through to the host", async () => {
    const { app, cookie, id } = await withApp();
    app.deps.host.logLines.set("container-1", [{ text: "x\n", stream: "stdout" }]);
    await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/container-1/logs?tail=50&follow=false`,
      headers: { cookie },
    });
    expect(app.deps.host.logCalls[0]).toMatchObject({
      containerId: "container-1",
      tail: 50,
      follow: false,
    });
    await app.close();
  });

  it("clamps a too-large tail but defaults an unparseable one", async () => {
    // Two different failures with two different right answers. Clamping garbage to the
    // maximum served 5000 lines for `?tail=abc` — the most expensive response available,
    // handed out for input that meant nothing.
    const { app, cookie, id } = await withApp();
    app.deps.host.logLines.set("container-1", [{ text: "x\n", stream: "stdout" }]);
    const tailFor = async (query: string) => {
      app.deps.host.logCalls.length = 0;
      await app.inject({
        method: "GET",
        url: `/api/apps/${id}/containers/container-1/logs${query}`,
        headers: { cookie },
      });
      return app.deps.host.logCalls[0]?.tail;
    };
    expect(await tailFor("?tail=999999")).toBe(5000);
    expect(await tailFor("?tail=abc")).toBe(200);
    expect(await tailFor("?tail=-5")).toBe(200);
    expect(await tailFor("?tail=0")).toBe(200);
    expect(await tailFor("")).toBe(200);
    await app.close();
  });

  it("answers 503 rather than 500 when Docker cannot be reached", async () => {
    // The ownership check needs a container list. A wedged socket must not surface as an
    // opaque 500, and must NOT fall through to streaming — an empty list would make the
    // ownership check vacuous.
    const { app, cookie, id } = await withApp();
    app.deps.host.listContainers = async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/container-1/logs`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("docker_unreachable");
    await app.close();
  });

  it("passes an abort signal to streamLogs", async () => {
    // The route must pass a signal so streamLogs can clean up when the client disconnects.
    // Without it, an idle container with follow:true holds the Docker socket open forever.
    const { app, cookie, id } = await withApp();
    app.deps.host.logLines.set("container-1", [{ text: "x\n", stream: "stdout" }]);
    await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/container-1/logs?follow=true`,
      headers: { cookie },
    });
    expect(app.deps.host.logCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    await app.close();
  });

  it("emits exactly one done event", async () => {
    // Mutation testing found that deleting the terminal done event left all tests passing.
    // A regression would be silent — the pane would never show the "stream ended" state.
    const { app, cookie, id } = await withApp();
    app.deps.host.logLines.set("container-1", [{ text: "x\n", stream: "stdout" }]);
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/container-1/logs`,
      headers: { cookie },
    });
    expect(res.body.match(/event: done/g)).toHaveLength(1);
    await app.close();
  });

  it("clears the heartbeat interval when the stream closes", async () => {
    // Mutation testing found that gutting finish() so the heartbeat was never cleared left
    // all tests passing. A regression would leak one timer per stream, writing to a dead
    // socket every 25s for the life of the process.
    const { app, cookie, id } = await withApp();
    app.deps.host.logLines.set("container-1", [{ text: "x\n", stream: "stdout" }]);
    const baselineTimers = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/container-1/logs`,
      headers: { cookie },
    });
    // Give the stream cleanup time to complete.
    await new Promise((resolve) => setImmediate(resolve));
    // The interval is cleared when the stream ends. Without it, this would be baseline + 1.
    const afterTimers = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(afterTimers).toBe(baselineTimers);
    await app.close();
  });

  it("does not leak error details when the stream fails", async () => {
    // Phase 1A already ruled that database error text (bound SQL parameters) must not
    // reach clients. The same applies here: error.message on this path can be a dockerode
    // failure carrying filesystem paths, or LogFramingError revealing internal state.
    const { app, cookie, id } = await withApp();
    app.deps.host.streamLogs = async function* () {
      yield { text: "started\n", stream: "stdout" };
      throw new Error('SQLITE_BUSY: near "password"');
    };
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/container-1/logs`,
      headers: { cookie },
    });
    expect(res.body).toContain("event: error");
    // The raw error message must not appear.
    expect(res.body).not.toContain("SQLITE_BUSY");
    expect(res.body).not.toContain("password");
    await app.close();
  });
});
