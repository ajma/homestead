import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

describe("GET /api/setup/host-check", () => {
  it("reports the compose root, a real docker version, and the preflight result", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/setup/host-check",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.composeRoot).toBe("string");
    expect(body.docker.ok).toBe(true);
    expect(body.docker.version).toBeTruthy();
    expect(body.preflight.ok).toBe(true);
  });

  it("reports a dead Docker socket as a failure rather than throwing", async () => {
    // The whole point of this screen is to fail loudly HERE. A 500 would tell the user
    // Homestead is broken; what is actually broken is their socket, and they can fix it.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.dockerVersion = async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };
    const res = await app.inject({
      method: "GET",
      url: "/api/setup/host-check",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().docker).toMatchObject({ ok: false });
    expect(res.json().docker.message).toContain("docker.sock");
  });

  it("still reports the preflight when Docker itself is fine", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.preflight = async () => ({ ok: false, reason: "marker not visible from the daemon" });
    const res = await app.inject({
      method: "GET",
      url: "/api/setup/host-check",
      headers: { cookie },
    });
    expect(res.json().docker.ok).toBe(true);
    expect(res.json().preflight).toEqual({
      ok: false,
      reason: "marker not visible from the daemon",
    });
  });

  it("does not let one failure hide the other", async () => {
    // Both broken is the realistic case for a wrong bind mount, and a user fixing one
    // needs to know the other is also wrong rather than discovering it on the next screen.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    app.deps.host.dockerVersion = async () => {
      throw new Error("no socket");
    };
    app.deps.preflight = async () => ({ ok: false, reason: "path mismatch" });
    const body = (
      await app.inject({ method: "GET", url: "/api/setup/host-check", headers: { cookie } })
    ).json();
    expect(body.docker.ok).toBe(false);
    expect(body.preflight.ok).toBe(false);
  });

  it("is admin-only", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "GET",
      url: "/api/setup/host-check",
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
