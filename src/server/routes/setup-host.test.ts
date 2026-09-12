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
    // Asserts identity with what FakeHost actually supplies, not just truthiness/shape —
    // a handler returning fixed strings would satisfy a looser check.
    expect(body).toMatchObject({
      composeRoot: app.deps.config.composeRoot,
      docker: { ok: true, version: "27.3.1", apiVersion: "1.47", os: "linux", arch: "x86_64" },
      preflight: { ok: true },
    });
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

  it("serialises concurrent re-check requests into a single preflight run", async () => {
    // Each preflight run starts a real container. The re-check button is exactly where a
    // user double-clicks while fixing their bind mount, so a second concurrent request
    // must reuse the first run's in-flight promise rather than starting its own container.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);

    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.deps.preflight = async () => {
      calls += 1;
      await gate;
      return { ok: true };
    };

    const first = app.inject({ method: "GET", url: "/api/setup/host-check", headers: { cookie } });
    // Wait until the first request has actually entered (and is gated inside) its
    // preflight run before firing the second, so the two provably overlap.
    while (calls === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const second = app.inject({ method: "GET", url: "/api/setup/host-check", headers: { cookie } });
    // Give the second request's handler time to reach the shared run while it is still
    // gated, before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release?.();

    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a.json().preflight).toEqual({ ok: true });
    expect(b.json().preflight).toEqual({ ok: true });
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
