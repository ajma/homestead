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

/** Polls until `ready`, or fails loudly rather than hanging the suite. */
async function until<T>(attempt: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await attempt();
    if (ready(value)) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition never became true");
}

describe("lifecycle routes", () => {
  it("starts a job and returns its id immediately", async () => {
    const { app, cookie, id } = await withApp();
    app.deps.host.composeResults.set("up -d", { exitCode: 0, stdout: "started\n", stderr: "" });
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().jobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await app.close();
  });

  it("refuses an unknown action rather than passing it to compose", async () => {
    const { app, cookie, id } = await withApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/rm%20-rf`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_action");
    // Nothing reached the host.
    expect(app.deps.host.composeCalls.some((c) => c.args.includes("rm -rf"))).toBe(false);
    await app.close();
  });

  it("refuses a viewer", async () => {
    const { app, cookie, id } = await withApp();
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns 404 for an app outside the caller's scope", async () => {
    const { app, cookie, id } = await withApp();
    const created = await app.inject({
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
    expect(created.statusCode).toBe(201);
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "scoped@example.com", password: "correct-horse-battery" },
    });
    const scoped = String(signIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie: scoped },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 409 when a job is already running for the app", async () => {
    const { app, cookie, id } = await withApp();
    app.deps.host.composeResults.set("pull", { exitCode: 0, stdout: "ok\n", stderr: "" });
    app.deps.host.gateCompose();
    const first = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/pull`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/down`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("job_running");
    expect(second.json().runningJobId).toBe(first.json().jobId);
    app.deps.host.releaseCompose();
    await app.close();
  });

  it("reports a finished job with its output", async () => {
    const { app, cookie, id } = await withApp();
    app.deps.host.composeResults.set("up -d", { exitCode: 0, stdout: "started\n", stderr: "" });
    const started = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie },
    });
    const jobId = started.json().jobId;
    // Poll rather than `await live(jobId)?.done`: `live` returns undefined once the job
    // has finished, so `?.done` silently no-ops and the GET below races the runner.
    const res = await until(
      () => app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: { cookie } }),
      (r) => r.json().status !== "running",
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "succeeded", exitCode: 0, kind: "up" });
    expect(res.json().output).toContain("started");
    await app.close();
  });

  it("streams a running job's output over SSE and ends with a result event", async () => {
    const { app, cookie, id } = await withApp();
    app.deps.host.composeChunkCount = 4;
    app.deps.host.composeResults.set("up -d", { exitCode: 0, stdout: "abcdefgh", stderr: "" });
    const started = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${started.json().jobId}/stream`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    // Chunks arrive as separate events — the fake splits into four, and code that
    // assumed one blob would emit one.
    expect(res.body.match(/event: output/g)?.length).toBeGreaterThan(1);
    expect(res.body).toContain("event: done");
    const payloads = [...res.body.matchAll(/event: output\ndata: (.*)/g)]
      .map((m) => JSON.parse(m[1] ?? "{}").text)
      .join("");
    expect(payloads).toBe("abcdefgh");
    await app.close();
  });

  it("returns 404 streaming a job id that does not exist", async () => {
    const { app, cookie } = await withApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/jobs/01ARZ3NDEKTSV4RRFFQ69G5FAV/stream",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
