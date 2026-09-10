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

  it("clamps an absurd tail rather than passing it through", async () => {
    const { app, cookie, id } = await withApp();
    app.deps.host.logLines.set("container-1", [{ text: "x\n", stream: "stdout" }]);
    await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/container-1/logs?tail=999999`,
      headers: { cookie },
    });
    expect(app.deps.host.logCalls[0]?.tail).toBe(5000);
    await app.close();
  });
});
