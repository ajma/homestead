import type { Step } from "@server/apps/step-sequence";
import { apps, jobs } from "@server/db/schema";
import type { TestApp } from "@server/test-helpers";
import { buildTestApp, createScopedAdmin, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
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

/** Adopts a directory named `name`, the way `withApp` does but for a directory the caller
 * chooses — the system-app tests need distinct directories per app rather than the one
 * `withApp` hardcodes. */
async function createApp(app: TestApp, cookie: string, opts: { name: string }): Promise<string> {
  app.deps.host.files.set(`${opts.name}/compose.yaml`, "services: {}\n");
  app.deps.host.composeResults.set("config --format json", {
    exitCode: 0,
    stdout: CONFIG,
    stderr: "",
  });
  const adopted = await app.inject({
    method: "POST",
    url: "/api/apps/adopt",
    headers: { cookie },
    payload: { directories: [opts.name] },
  });
  return adopted.json().adopted[0].id as string;
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

  it("scopes GET /api/jobs/:jobId to the caller's own apps, not just GET /api/apps/:id/jobs", async () => {
    // Measured in the 1E final-fix brief: deleting `jobs.ts:60`'s scope check left all
    // 885 tests green. A scoped admin can be created and correctly 404s here today —
    // without the check, they could read any job's raw output, which carries compose
    // stderr with filesystem paths and interpolated `.env` values.
    const { app, cookie, id } = await withApp();
    app.deps.host.composeResults.set("up -d", { exitCode: 0, stdout: "started\n", stderr: "" });
    const started = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie },
    });
    const jobId = started.json().jobId as string;

    const outOfScope = await createScopedAdmin(app, cookie, { appIds: [] });
    const outOfScopeRes = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { cookie: outOfScope.cookie },
    });
    expect(outOfScopeRes.statusCode).toBe(404);

    const inScope = await createScopedAdmin(app, cookie, { appIds: [id] });
    const inScopeRes = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { cookie: inScope.cookie },
    });
    expect(inScopeRes.statusCode).toBe(200);
    await app.close();
  });

  it("streams a running job's output over SSE and ends with a result event", async () => {
    const { app, cookie, id } = await withApp();
    app.deps.host.composeChunkCount = 4;
    app.deps.host.composeResults.set("up -d", { exitCode: 0, stdout: "abcdefgh", stderr: "" });

    // Gate the job so it is still LIVE when the stream attaches. Without this the test
    // is a coin flip: the fake finishes in a microtask, `runner.live()` returns
    // undefined, and the handler takes the replay branch — which correctly emits the
    // persisted output as ONE event, failing an assertion about four. Measured: it lost
    // roughly one run in five.
    app.deps.host.gateCompose();
    const started = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie },
    });
    const streaming = app.inject({
      method: "GET",
      url: `/api/jobs/${started.json().jobId}/stream`,
      headers: { cookie },
    });
    // Let the handler reach its iteration before any chunk exists.
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.deps.host.releaseCompose();
    const res = await streaming;
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

  it("closes the stream and reports the error when the job output throws", async () => {
    // After hijack() Fastify cannot report an error — the headers are already out — so
    // an unguarded throw leaves the stream open and its 25s heartbeat firing for the
    // life of the process, one timer per abandoned stream.
    const { app, cookie, id } = await withApp();
    app.deps.host.composeResults.set("up -d", { exitCode: 0, stdout: "x", stderr: "" });
    app.deps.host.gateCompose();
    const started = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie },
    });
    const jobId = started.json().jobId;
    const live = app.deps.jobs.live(jobId);
    if (live) {
      Object.defineProperty(live, "output", {
        value: {
          async *[Symbol.asyncIterator]() {
            yield { text: "partial", stream: "stdout" as const };
            throw new Error("stream exploded");
          },
        },
      });
    }
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/stream`,
      headers: { cookie },
    });
    // It completed rather than hanging, and said what happened.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("partial");
    expect(res.body).toContain("event: error");
    expect(res.body.match(/event: done/g)).toHaveLength(1);
    app.deps.host.releaseCompose();
    await app.close();
  });

  it("sends exactly one terminal event whether the job succeeds or throws", async () => {
    // A client that tears down its EventSource on `done` is left hanging if the stream
    // sends `error` but no `done`. Every path must send exactly one terminal event.
    const { app, cookie, id } = await withApp();

    // Success case
    app.deps.host.composeResults.set("up -d", { exitCode: 0, stdout: "ok", stderr: "" });
    const success = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie },
    });
    const successStream = await app.inject({
      method: "GET",
      url: `/api/jobs/${success.json().jobId}/stream`,
      headers: { cookie },
    });
    expect(successStream.body.match(/event: done/g)).toHaveLength(1);
    expect(successStream.body).not.toContain("event: error");

    // Failure case
    app.deps.host.composeResults.set("down", { exitCode: 0, stdout: "x", stderr: "" });
    app.deps.host.gateCompose();
    const fail = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/down`,
      headers: { cookie },
    });
    const failJobId = fail.json().jobId;
    const live = app.deps.jobs.live(failJobId);
    if (live) {
      Object.defineProperty(live, "output", {
        value: {
          async *[Symbol.asyncIterator]() {
            yield { text: "starting", stream: "stdout" as const };
            throw new Error("failed");
          },
        },
      });
    }
    const failStream = await app.inject({
      method: "GET",
      url: `/api/jobs/${failJobId}/stream`,
      headers: { cookie },
    });
    expect(failStream.body).toContain("event: error");
    expect(failStream.body.match(/event: done/g)).toHaveLength(1);
    app.deps.host.releaseCompose();
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

  it("does not leak error details when the stream fails", async () => {
    // Phase 1A already ruled that database error text (bound SQL parameters) must not
    // reach clients. The job stream's catch covers db.select, whose error text can carry
    // bound parameters. Send a generic message, not error.message.
    const { app, cookie, id } = await withApp();
    app.deps.host.composeResults.set("up -d", { exitCode: 0, stdout: "x", stderr: "" });
    app.deps.host.gateCompose();
    const started = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie },
    });
    const jobId = started.json().jobId;
    const live = app.deps.jobs.live(jobId);
    if (live) {
      Object.defineProperty(live, "output", {
        value: {
          async *[Symbol.asyncIterator]() {
            yield { text: "partial", stream: "stdout" as const };
            throw new Error('SQLITE_BUSY: near "password"');
          },
        },
      });
    }
    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/stream`,
      headers: { cookie },
    });
    expect(res.body).toContain("event: error");
    // The raw error message must not appear.
    expect(res.body).not.toContain("SQLITE_BUSY");
    expect(res.body).not.toContain("password");
    app.deps.host.releaseCompose();
    await app.close();
  });
});

describe("system apps", () => {
  it("refuses every lifecycle action on Homestead marked self by REAL detection, not a seeded row", async () => {
    // Every other test in this block seeds `systemKind` directly (`db.update(apps).set(...)`)
    // to exercise the guard in isolation from how marking happens. This one instead runs
    // the actual pipeline 2F Task 2 adds (`self-detect.ts`, wired into `POST
    // /api/apps/adopt`) end to end, so the guard is proven to fire against a row this
    // codebase's own detection produced — the assertion the task brief calls out
    // specifically, since every guard test before this one could pass against a
    // `systemKind` no code path actually sets in production.
    const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
    const originalHostname = process.env.HOSTNAME;
    process.env.HOSTNAME = "abc123";
    try {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      app.deps.host.containers = [
        {
          id: `abc123${"0".repeat(58)}`,
          names: ["homestead"],
          image: "homestead:latest",
          state: "running",
          status: "Up",
          project: "homestead",
          service: "homestead",
          labels: { [WORKING_DIR_LABEL]: "/volume2/docker/homestead" },
        },
      ];
      const id = await createApp(app, cookie, { name: "homestead" });

      const [row] = await app.deps.db.select().from(apps).where(eq(apps.id, id));
      expect(row?.systemKind).toBe("self");

      for (const kind of ["up", "down", "restart", "pull"]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/apps/${id}/actions/${kind}`,
          headers: { cookie },
        });
        expect(res.statusCode, `${kind} should be refused`).toBe(409);
        expect(res.json().error, `${kind} should say why`).toBe("system_app");
      }
      await app.close();
    } finally {
      if (originalHostname === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = originalHostname;
    }
  });

  it("refuses every lifecycle action on a self-adopted Homestead", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const id = await createApp(app, cookie, { name: "homestead" });
    await app.deps.db.update(apps).set({ systemKind: "self" }).where(eq(apps.id, id));

    for (const kind of ["up", "down", "restart", "pull"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/apps/${id}/actions/${kind}`,
        headers: { cookie },
      });
      expect(res.statusCode, `${kind} should be refused`).toBe(409);
      expect(res.json().error, `${kind} should say why`).toBe("system_app");
    }
    await app.close();
  });

  it("allows lifecycle actions on the managed cloudflared stack", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const id = await createApp(app, cookie, { name: "cloudflared" });
    await app.deps.db.update(apps).set({ systemKind: "cloudflared" }).where(eq(apps.id, id));

    for (const kind of ["up", "restart", "pull"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/apps/${id}/actions/${kind}`,
        headers: { cookie },
      });
      expect(res.statusCode, `${kind} should be allowed`).toBe(202);
    }
    await app.close();
  });

  it("allows `down` on the managed cloudflared stack too", async () => {
    // Not refused, unlike `self`. The confirmation for anything destructive is the
    // client's job, and a server that refused `down` here would make the UI's confirm
    // dialog a lie. A reader will otherwise "tighten" this into a 409 and break the UI.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const id = await createApp(app, cookie, { name: "cloudflared" });
    await app.deps.db.update(apps).set({ systemKind: "cloudflared" }).where(eq(apps.id, id));

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/down`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });

  it("still allows every lifecycle action on an ordinary app", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const id = await createApp(app, cookie, { name: "ordinary" });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/up`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });

  it("refuses before it starts anything", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const id = await createApp(app, cookie, { name: "homestead" });
    await app.deps.db.update(apps).set({ systemKind: "self" }).where(eq(apps.id, id));

    await app.inject({ method: "POST", url: `/api/apps/${id}/actions/down`, headers: { cookie } });

    // No job row, and nothing reached the host — a 409 that still ran the command would be
    // the worst of both.
    expect(await app.deps.db.select().from(jobs)).toEqual([]);
    await app.close();
  });

  it("tells a scoped admin nothing about a system app outside their scope", async () => {
    // Finding from the 1H task-4 brief: no existing test caught that the guard must sit
    // after `loadApp`, so a scoped admin still 404s on a system app they cannot see rather
    // than learning of its existence via a 409. Moving the guard above `loadApp` (and
    // re-querying the row without the scope filter, since a row that hasn't loaded yet
    // cannot be guarded on) leaves every other test in this file green.
    const { app, cookie, id } = await withApp();
    await app.deps.db.update(apps).set({ systemKind: "self" }).where(eq(apps.id, id));
    const outOfScope = await createScopedAdmin(app, cookie, { appIds: [] });

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/actions/down`,
      headers: { cookie: outOfScope.cookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /api/jobs/:jobId/stream against a job with no app", () => {
  // 2C Task 4: `StepJobRunner`-run sequences (the tunnel provision job, and any future
  // one) record with `appId: null` and have no `live` handle at all (`StepJobRunner`'s own
  // class doc: "there is no live/cancel here"). Before this fix, `!live` alone meant
  // "already finished" here, so attaching to one of these while it was still running
  // reported `done` immediately with whatever the (still-empty) persisted `output` column
  // held — a false completion a client cannot tell from a real one.
  //
  // A trivial one-step, gated sequence run directly through `app.deps.stepJobs`, not the
  // Cloudflare route: this is testing `jobs.ts`'s general handling of "no live handle, no
  // app", not anything Cloudflare-specific, and a fake step is enough to hold the job in
  // `running` on demand.
  function gatedNoAppStep(): { steps: Array<Step<Record<string, never>>>; release: () => void } {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const steps: Array<Step<Record<string, never>>> = [
      {
        name: "wait",
        async run() {
          await gate;
        },
        async undo() {},
      },
    ];
    if (!release) throw new Error("release was not assigned synchronously");
    return { steps, release };
  }

  it("holds the stream open until the job reaches a terminal status, then sends the real result", async () => {
    const app = await buildTestApp();
    const { cookie, id: userId } = await signUpAdmin(app);
    const { steps, release } = gatedNoAppStep();

    const startPromise = app.deps.stepJobs.start(null, "test_no_app_kind", steps, {}, userId);
    const foundJobId = await until(
      async () => {
        const [row] = await app.deps.db
          .select()
          .from(jobs)
          .where(eq(jobs.kind, "test_no_app_kind"));
        return row?.id ?? null;
      },
      (found) => found !== null,
    );
    if (foundJobId === null) throw new Error("job row was never inserted");
    const jobId = foundJobId;

    const streaming = app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/stream`,
      headers: { cookie },
    });
    // Give the handler a moment to reach the polling branch before proving it is still
    // waiting — a coin-flip win by finishing instantly would pass for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [stillRunning] = await app.deps.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(stillRunning?.status).toBe("running");

    release();
    const res = await streaming;
    await startPromise;

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: done");
    expect(res.body).toContain('"status":"succeeded"');

    const [finished] = await app.deps.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(finished?.status).toBe("succeeded");
    await app.close();
  });

  it("still answers immediately for a no-app job that had already finished", async () => {
    const app = await buildTestApp();
    const { cookie, id: userId } = await signUpAdmin(app);
    const steps: Array<Step<Record<string, never>>> = [
      { name: "noop", async run() {}, async undo() {} },
    ];
    const { id: jobId } = await app.deps.stepJobs.start(
      null,
      "test_no_app_kind",
      steps,
      {},
      userId,
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/stream`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: done");
    expect(res.body).toContain('"status":"succeeded"');
    await app.close();
  });
});

describe("GET /api/jobs/:jobId against a job with no app (Minor 3)", () => {
  // The `/stream` route above already handles a null `appId` — this is `GET
  // /api/jobs/:jobId` itself, which still 404'd on one before this fix. Latent in
  // production today (`JobOutput` only ever calls `/stream`), but a fourth shape of the
  // "job id the client cannot resolve" family the 2B carry-forward found three of.
  it("returns the job instead of 404ing, once it has finished", async () => {
    const app = await buildTestApp();
    const { cookie, id: userId } = await signUpAdmin(app);
    const steps: Array<Step<Record<string, never>>> = [
      { name: "noop", async run() {}, async undo() {} },
    ];
    const { id: jobId } = await app.deps.stepJobs.start(
      null,
      "test_no_app_kind",
      steps,
      {},
      userId,
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: jobId, appId: null, status: "succeeded" });
    await app.close();
  });
});
