import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

const CONFIG = JSON.stringify({
  name: "jellyfin",
  services: {
    web: { image: "nginx", ports: [{ published: "8096" }] },
    admin: { image: "nginx", ports: [{ published: "9000" }] },
  },
});

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

/** `withApp` plus one http probe, for the tests below that need a probe to mutate. */
async function withProbe() {
  const { app, cookie, id: appId } = await withApp();
  const created = await app.inject({
    method: "POST",
    url: `/api/apps/${appId}/probes`,
    headers: { cookie },
    payload: { kind: "http_internal", target: "http://localhost:8096" },
  });
  return { app, cookie, appId, probeId: created.json().id as string };
}

describe("probe routes", () => {
  it("creates a docker probe when an app is adopted", async () => {
    const { app, cookie, id } = await withApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/probes`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0]).toMatchObject({ kind: "docker", enabled: true });
    await app.close();
  });

  it("suggests internal targets from the published ports", async () => {
    const { app, cookie, id } = await withApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/probes/suggestions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((s: { target: string }) => s.target)).toEqual([
      "http://localhost:8096",
      "http://localhost:9000",
    ]);
    await app.close();
  });

  it("accepts several internal probes for one app", async () => {
    // An *arr stack has four web UIs; one URL per app under-reports it.
    const { app, cookie, id } = await withApp();
    for (const target of ["http://localhost:8096", "http://localhost:9000"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/apps/${id}/probes`,
        headers: { cookie },
        payload: { kind: "http_internal", target, label: target },
      });
      expect(res.statusCode).toBe(201);
    }
    const list = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/probes`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(3); // the docker probe plus two
    await app.close();
  });

  it("refuses a second docker probe for one app", async () => {
    const { app, cookie, id } = await withApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/probes`,
      headers: { cookie },
      payload: { kind: "docker" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("probe_exists");
    await app.close();
  });

  it("requires a target for an http probe", async () => {
    const { app, cookie, id } = await withApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/probes`,
      headers: { cookie },
      payload: { kind: "http_internal" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a target that is not http or https", async () => {
    // The target is fetched by the server. A `file:` or `gopher:` target is an SSRF
    // primitive dressed as a health check.
    const { app, cookie, id } = await withApp();
    for (const target of ["file:///etc/passwd", "gopher://x", "javascript:alert(1)"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/apps/${id}/probes`,
        headers: { cookie },
        payload: { kind: "http_internal", target },
      });
      expect(res.statusCode, target).toBe(400);
    }
    await app.close();
  });

  it("updates and deletes a probe", async () => {
    const { app, cookie, id } = await withApp();
    const created = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/probes`,
      headers: { cookie },
      payload: { kind: "http_internal", target: "http://localhost:8096" },
    });
    expect(created.statusCode).toBe(201);
    const probeId = created.json().id;
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/probes/${probeId}`,
      headers: { cookie },
      payload: { intervalSeconds: 120, enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ intervalSeconds: 120, enabled: false });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/probes/${probeId}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(204);
    await app.close();
  });

  it("refuses a viewer everywhere", async () => {
    // A probe's target is an internal URL and its detail can carry response fragments.
    const { app, cookie, id } = await withApp();
    const viewer = await createViewer(app, cookie);
    const listRes = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/probes`,
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const probeId = listRes.json()[0].id;
    const attempts: Array<[string, string]> = [
      ["GET", `/api/apps/${id}/probes`],
      ["GET", `/api/apps/${id}/probes/suggestions`],
      ["POST", `/api/apps/${id}/probes`],
      ["PATCH", `/api/probes/${probeId}`],
      ["DELETE", `/api/probes/${probeId}`],
    ];
    for (const [method, url] of attempts) {
      const res = await app.inject({
        method: method as never,
        url,
        headers: { cookie: viewer.cookie },
        payload: { kind: "http_internal", target: "http://x" },
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    await app.close();
  });

  it("returns 404 for a probe on an app outside the caller's scope", async () => {
    const { app, cookie, id } = await withApp();
    const listRes = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/probes`,
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const probeId = listRes.json()[0].id;
    await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie },
      payload: {
        email: "scoped@example.com",
        password: "correct-horse-battery",
        name: "S",
        role: "admin",
        scopeAllApps: false,
        appIds: [],
      },
    });
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "scoped@example.com", password: "correct-horse-battery" },
    });
    const scoped = String(signIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/probes/${probeId}`,
      headers: { cookie: scoped },
      payload: { enabled: false },
    });
    expect(patched.statusCode).toBe(404);
    await app.close();
  });

  it("tells open tabs when a probe is created", async () => {
    // Same reason as disabling one below: the tile's cached probe set just changed.
    const { app, cookie, id: appId } = await withApp();
    const seen: string[] = [];
    app.deps.events.subscribeAppChanged?.((id: string) => seen.push(id));
    await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/probes`,
      headers: { cookie },
      payload: { kind: "http_internal", target: "http://localhost:8096" },
    });
    expect(seen).toEqual([appId]);
    await app.close();
  });

  it("tells open tabs when a probe is disabled, or they keep showing its old status", async () => {
    // Measured in Phase 1D: docker up plus http down reads down/"Containers not running".
    // Disable the http probe and the server would now say up/"Healthy" while every open
    // tab stays wrong until its stream happens to reconnect.
    const { app, cookie, appId, probeId } = await withProbe();
    const seen: string[] = [];
    app.deps.events.subscribeAppChanged?.((id: string) => seen.push(id));
    await app.inject({
      method: "PATCH",
      url: `/api/probes/${probeId}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(seen).toEqual([appId]);
    await app.close();
  });

  it("tells open tabs when a probe is deleted", async () => {
    const { app, cookie, appId, probeId } = await withProbe();
    const seen: string[] = [];
    app.deps.events.subscribeAppChanged?.((id: string) => seen.push(id));
    await app.inject({ method: "DELETE", url: `/api/probes/${probeId}`, headers: { cookie } });
    expect(seen).toEqual([appId]);
    await app.close();
  });

  it("does not announce a probe edit that changes nothing a tile shows", async () => {
    // A label change moves no status. Announcing it makes every open tab refetch the
    // launcher for a cosmetic edit.
    const { app, cookie, probeId } = await withProbe();
    const seen: string[] = [];
    app.deps.events.subscribeAppChanged?.((id: string) => seen.push(id));
    await app.inject({
      method: "PATCH",
      url: `/api/probes/${probeId}`,
      headers: { cookie },
      payload: { label: "Renamed" },
    });
    expect(seen).toEqual([]);
    await app.close();
  });

  it("does not announce a PATCH that sets enabled to the value it already had", async () => {
    // Not required by the brief, but the fix is "a PATCH that changes enabled" — an
    // idempotent enabled: true against an already-enabled probe changes no status either.
    const { app, cookie, probeId } = await withProbe();
    const seen: string[] = [];
    app.deps.events.subscribeAppChanged?.((id: string) => seen.push(id));
    await app.inject({
      method: "PATCH",
      url: `/api/probes/${probeId}`,
      headers: { cookie },
      payload: { enabled: true },
    });
    expect(seen).toEqual([]);
    await app.close();
  });
});
