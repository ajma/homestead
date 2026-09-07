import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { operations, user } from "../db/schema.js";
import { createFakeDocker, type FakeDocker } from "../docker/fake.js";

const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let auth: ReturnType<typeof createAuth>;
let root: string;
let adminCookie: string;
let viewerCookie: string;
/**
 * Never a plausible user stack name. Compose reconciles by project-name label,
 * so a fixture called `media` reaching a real daemon would clobber a real
 * `media` stack. The fake runner below is the primary guard; this is the belt
 * to its braces.
 */
let slug: string;
let fake: FakeDocker;

async function signIn(email: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password: "correct-horse-battery" },
    asResponse: true,
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

/** Builds the app with a scripted Docker double. */
async function build(options: Parameters<typeof createFakeDocker>[0] = {}) {
  fake = createFakeDocker({
    config: { name: slug, services: { web: { image: "nginx" } } },
    ...options,
  });
  app = await buildApp({
    db,
    auth,
    secretKey: Buffer.alloc(32),
    projectsDir: root,
    projectsHostDir: root,
    dataDir: root,
    docker: fake.runner,
  });
}

/** Polls the operation route until the background run has finished. */
async function settle(id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i++) {
    const res = await app.inject({
      method: "GET",
      url: `/api/operations/${id}`,
      headers: { cookie: adminCookie },
    });
    if (res.statusCode === 200 && res.json().status !== "running")
      return res.json();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`operation ${id} never reached a terminal state`);
}

beforeEach(async () => {
  slug = `hs-test-${randomUUID().slice(0, 8)}`;
  root = await mkdtemp(join(tmpdir(), "hs-ops-"));
  await mkdir(join(root, slug), { recursive: true });
  await writeFile(
    join(root, slug, "docker-compose.yml"),
    `name: ${slug}\nservices:\n  web:\n    image: nginx\n`,
  );
  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);
  await build();
  const a = await auth.api.signUpEmail({
    body: {
      email: "admin@example.com",
      name: "A",
      password: "correct-horse-battery",
    },
  });
  await db.update(user).set({ role: "admin" }).where(eq(user.id, a.user.id));
  await auth.api.signUpEmail({
    body: {
      email: "viewer@example.com",
      name: "V",
      password: "correct-horse-battery",
    },
  });
  adminCookie = await signIn("admin@example.com");
  viewerCookie = await signIn("viewer@example.com");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("lifecycle routes", () => {
  it("denies a viewer starting an operation", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/up`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(fake.streamed).toEqual([]);
  });

  it("requires a session", async () => {
    expect(
      (await app.inject({ method: "POST", url: `/api/projects/${slug}/up` }))
        .statusCode,
    ).toBe(401);
    expect(fake.streamed).toEqual([]);
  });

  it("returns an operation id for an admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/up`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().operationId;
    expect(typeof id).toBe("string");
    const final = await settle(id);
    expect(final.status).toBe("succeeded");
    expect(fake.streamed[0]?.args.slice(-2)).toEqual(["up", "-d"]);
  });

  it("404s an unknown project without starting anything", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/nope/up",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(fake.streamed).toEqual([]);
  });

  it("rejects an unknown verb", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/destroy`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(fake.streamed).toEqual([]);
  });

  it("returns exactly 409 while an operation is running for the project", async () => {
    let release!: (code: number) => void;
    const gate = new Promise<number>((r) => {
      release = r;
    });
    await build({ stream: () => gate });

    const first = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/pull`,
      headers: { cookie: adminCookie },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/up`,
      headers: { cookie: adminCookie },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("operation_in_progress");
    // The rejected request must not have reached docker at all.
    expect(fake.streamed).toHaveLength(1);

    release(0);
    await settle(first.json().operationId);
  });

  it("allows a new operation once the previous one finished", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/pull`,
      headers: { cookie: adminCookie },
    });
    await settle(first.json().operationId);
    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/up`,
      headers: { cookie: adminCookie },
    });
    expect(second.statusCode).toBe(202);
    await settle(second.json().operationId);
  });

  it("exposes operation history in the shared Operation shape", async () => {
    const started = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/up`,
      headers: { cookie: adminCookie },
    });
    await settle(started.json().operationId);

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/operations`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const [op] = res.json().operations;
    expect(op).toMatchObject({ slug, kind: "up", status: "succeeded" });
    // `output` blobs and the audit column stay server-side.
    expect(op).not.toHaveProperty("output");
    expect(op).not.toHaveProperty("projectSlug");
    expect(op).not.toHaveProperty("actorUserId");
  });

  it("lists an operation while it is still running", async () => {
    // The project page disables its lifecycle buttons from this listing. The
    // history row is only written when the run ends, so a database-only
    // answer here tells a second admin the project is idle while someone
    // else's `pull` is halfway through — and their click earns a 409.
    let release!: (code: number) => void;
    const held = new Promise<number>((resolve) => {
      release = resolve;
    });
    await build({ stream: () => held });

    const started = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/pull`,
      headers: { cookie: adminCookie },
    });
    expect(started.statusCode).toBe(202);
    const { operationId } = started.json();

    const during = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/operations`,
      headers: { cookie: adminCookie },
    });
    expect(during.json().operations).toMatchObject([
      { id: operationId, kind: "pull", status: "running", finishedAt: null },
    ]);

    release(0);
    await settle(operationId);

    // Once: the live entry and the history row are the same operation.
    const after = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/operations`,
      headers: { cookie: adminCookie },
    });
    expect(after.json().operations).toHaveLength(1);
    expect(after.json().operations[0]).toMatchObject({ status: "succeeded" });
  });

  it("does not capture the validate route with the verb route", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${slug}/validate`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("valid");
  });
});

describe("GET /api/operations/:id", () => {
  it("falls back to the database for an operation no longer in memory", async () => {
    const id = randomUUID();
    await db.insert(operations).values({
      id,
      projectSlug: slug,
      kind: "pull",
      status: "succeeded",
      exitCode: 0,
      actorUserId: null,
      startedAt: 1,
      finishedAt: 2,
      output: "a very large blob",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/operations/${id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id,
      slug,
      kind: "pull",
      status: "succeeded",
      exitCode: 0,
      startedAt: 1,
      finishedAt: 2,
    });
  });

  it("404s an id that exists nowhere", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/operations/${randomUUID()}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/operations/:id/stream", () => {
  it("always resolves the operation on the terminal event", async () => {
    const id = randomUUID();
    await db.insert(operations).values({
      id,
      projectSlug: slug,
      kind: "up",
      status: "failed",
      exitCode: 1,
      actorUserId: null,
      startedAt: 1,
      finishedAt: 2,
      output: "",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/operations/${id}/stream`,
      headers: { cookie: adminCookie },
    });
    const frame = res.payload
      .split("\n\n")
      .map((f) => f.trim())
      .find((f) => f.startsWith("data: ") && f.includes('"end":true'));
    expect(frame).toBeDefined();
    const payload = JSON.parse((frame ?? "").slice(6));
    expect(payload.operation).toMatchObject({ id, slug, status: "failed" });
  });
});

describe("log streaming", () => {
  it("denies a viewer reading logs", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/logs`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(fake.streamed).toEqual([]);
  });

  it("builds the argv through the compose path and defaults tail to 200", async () => {
    await build({ output: ["hello from logs\n"] });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/logs`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("hello from logs");
    expect(res.payload).toContain('"end":true');
    expect(fake.streamed[0]?.args).toEqual([
      "compose",
      "-f",
      join(root, slug, "docker-compose.yml"),
      "logs",
      "--follow",
      "--tail",
      "200",
    ]);
  });

  it("passes a validated tail and a service through", async () => {
    await build();
    await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/logs?tail=25&service=web`,
      headers: { cookie: adminCookie },
    });
    expect(fake.streamed[0]?.args.slice(-4)).toEqual([
      "--follow",
      "--tail",
      "25",
      "web",
    ]);
  });

  it("rejects a service name that would smuggle a flag into the argv", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/logs?service=--no-log-prefix`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_service");
    expect(fake.streamed).toEqual([]);
  });

  it('rejects a non-numeric tail instead of sending docker "NaN"', async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/logs?tail=abc`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_tail");
    expect(fake.streamed).toEqual([]);
  });

  it("rejects an absurd tail rather than asking docker for it", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${slug}/logs?tail=99999999`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(fake.streamed).toEqual([]);
  });
});

describe("SSE framing", () => {
  it("encodes newlines so a multi-line chunk stays one event", async () => {
    const { encodeSseData } = await import("./operations.js");
    const frame = encodeSseData({ chunk: "line one\nline two\n" });
    expect(frame.split("\n\n")).toHaveLength(2);
    expect(frame.startsWith("data: ")).toBe(true);
    expect(JSON.parse(frame.slice(6).trimEnd()).chunk).toBe(
      "line one\nline two\n",
    );
  });
});
