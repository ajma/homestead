import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

const CONFIG = JSON.stringify({ name: "jellyfin", services: { web: { image: "nginx" } } });

const INSPECT = {
  id: "container-1",
  name: "jellyfin-web-1",
  image: "nginx:alpine",
  imageDigest: "sha256:abc",
  state: "exited",
  exitCode: 137,
  oomKilled: true,
  startedAt: "2026-09-10T00:00:00Z",
  finishedAt: "2026-09-10T01:00:00Z",
  restartPolicy: "unless-stopped",
  restartCount: 3,
  tty: false,
  env: [{ key: "DB_PASSWORD", masked: "••••••••" }],
  mounts: [{ source: "/volume2/media", destination: "/media", mode: "ro", type: "bind" }],
  ports: [{ container: 80, host: 8099, protocol: "tcp" }],
  networks: ["jellyfin_default"],
  health: {
    status: "unhealthy",
    failingStreak: 3,
    log: [{ exitCode: 1, output: "curl: (7)", end: "2026-09-10T01:00:00Z" }],
  },
};

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
      state: "exited",
      status: "Exited (137)",
      project: "jellyfin",
      service: "web",
      labels: {},
    },
  ];
  app.deps.host.inspected.set("container-1", INSPECT);
  const adopted = await app.inject({
    method: "POST",
    url: "/api/apps/adopt",
    headers: { cookie },
    payload: { directories: ["jellyfin"] },
  });
  return { app, cookie, id: adopted.json().adopted[0].id as string };
}

describe("container detail", () => {
  it("lists the app's containers", async () => {
    const { app, cookie, id } = await withApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0]).toMatchObject({ id: "container-1", service: "web", state: "exited" });
    await app.close();
  });

  it("returns the diagnostics the panel exists for", async () => {
    const { app, cookie, id } = await withApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/container-1`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    // The reason the web terminal was cut: these answer "why did it die" without a shell,
    // and work on a distroless image that has none.
    expect(res.json()).toMatchObject({
      exitCode: 137,
      oomKilled: true,
      restartCount: 3,
      restartPolicy: "unless-stopped",
    });
    expect(res.json().health.status).toBe("unhealthy");
    await app.close();
  });

  it("never returns an env value", async () => {
    const { app, cookie, id } = await withApp();
    app.deps.host.inspected.set("container-1", {
      ...INSPECT,
      env: [{ key: "DB_PASSWORD", masked: "••••••••" }],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/container-1`,
      headers: { cookie },
    });
    expect(res.body).not.toContain("hunter2");
    expect(res.json().env).toEqual([{ key: "DB_PASSWORD", masked: "••••••••" }]);
    await app.close();
  });

  it("refuses a container belonging to another app", async () => {
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
    app.deps.host.inspected.set("other-1", { ...INSPECT, id: "other-1" });
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers/other-1`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("refuses a viewer", async () => {
    const { app, cookie, id } = await withApp();
    const viewer = await createViewer(app, cookie);
    for (const url of [`/api/apps/${id}/containers`, `/api/apps/${id}/containers/container-1`]) {
      expect(
        (await app.inject({ method: "GET", url, headers: { cookie: viewer.cookie } })).statusCode,
      ).toBe(403);
    }
    await app.close();
  });

  it("stays 200 with an empty list when Docker is unreachable", async () => {
    // Same rule as the app list: a wedged socket must not 500 the screen.
    const { app, cookie, id } = await withApp();
    app.deps.host.listContainers = async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/containers`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });
});
