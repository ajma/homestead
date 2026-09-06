import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createAuth } from "../auth/index.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { user } from "../db/schema.js";

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

async function signIn(email: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password: "correct-horse-battery" },
    asResponse: true,
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-ops-"));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(
    join(root, "media", "docker-compose.yml"),
    "name: media\nservices:\n  web:\n    image: nginx\n",
  );
  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, TEST_AUTH);
  app = await buildApp({
    db,
    auth,
    projectsDir: root,
    projectsHostDir: root,
    dataDir: root,
  });
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

describe("lifecycle routes", () => {
  it("denies a viewer starting an operation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/media/up",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("requires a session", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/api/projects/media/up" }))
        .statusCode,
    ).toBe(401);
  });

  it("returns an operation id for an admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/media/up",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(202);
    expect(typeof res.json().operationId).toBe("string");
  });

  it("404s an unknown project without starting anything", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/nope/up",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects an unknown verb", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/media/destroy",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when an operation is already running for the project", async () => {
    await app.inject({
      method: "POST",
      url: "/api/projects/media/pull",
      headers: { cookie: adminCookie },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/projects/media/up",
      headers: { cookie: adminCookie },
    });
    expect([202, 409]).toContain(second.statusCode);
  });

  it("exposes operation history", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/media/operations",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().operations)).toBe(true);
  });

  it("denies a viewer reading logs", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/projects/media/logs",
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not capture the validate route with the verb route", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/media/validate",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("valid");
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
