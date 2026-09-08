import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildApp } from "./app.js";
import { createAuth } from "./auth/index.js";
import { createDb, runMigrations } from "./db/client.js";
import { tempDir } from "./test-support/tmp.js";

const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

async function boot() {
  const db = createDb(":memory:");
  await runMigrations(db);
  const auth = createAuth(db, TEST_AUTH);
  const tmpDir = await tempDir("hs-test-");
  return buildApp({
    db,
    auth,
    secretKey: Buffer.alloc(32),
    projectsDir: tmpDir,
    projectsHostDir: tmpDir,
    dataDir: tmpDir,
  });
}

async function makeBaseDeps() {
  const db = createDb(":memory:");
  await runMigrations(db);
  const auth = createAuth(db, TEST_AUTH);
  const tmpDir = await tempDir("hs-test-");
  return {
    db,
    auth,
    secretKey: Buffer.alloc(32),
    projectsDir: tmpDir,
    projectsHostDir: tmpDir,
    dataDir: tmpDir,
  };
}

describe("app", () => {
  it("responds to the health check", async () => {
    const app = await boot();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("defaults the logger off but accepts an override", async () => {
    const db = createDb(":memory:");
    await runMigrations(db);
    const auth = createAuth(db, TEST_AUTH);
    const tmpDir = await tempDir("hs-test-");
    const quiet = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      projectsDir: tmpDir,
      projectsHostDir: tmpDir,
      dataDir: tmpDir,
    });
    const loud = await buildApp({
      db,
      auth,
      secretKey: Buffer.alloc(32),
      logger: true,
      projectsDir: tmpDir,
      projectsHostDir: tmpDir,
      dataDir: tmpDir,
    });
    // With logging disabled Fastify installs an abstract no-op logger, which
    // has no level and silently discards every error we record. A real Pino
    // instance reports one.
    expect(quiet.log.level).toBeUndefined();
    expect(typeof loud.log.level).toBe("string");
    await quiet.close();
    await loud.close();
  });
});

// I2: without an error handler Fastify echoes the thrown message, so an
// unauthenticated client saw database paths and other internals.
describe("error handler", () => {
  it("masks a 5xx and does not leak the thrown message", async () => {
    const app = await boot();
    app.get("/api/_boom", async () => {
      throw new Error("db at /var/lib/homestead/homestead.db is corrupt");
    });
    const res = await app.inject({ method: "GET", url: "/api/_boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    expect(res.body).not.toContain("/var/lib/homestead");
    await app.close();
  });

  it("keeps Fastify's own body for a client error", async () => {
    const app = await boot();
    app.post(
      "/api/_validated",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
      async () => ({ ok: true }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/_validated",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("name");
    await app.close();
  });

  it("leaves 404 handling alone", async () => {
    const app = await boot();
    const res = await app.inject({ method: "GET", url: "/api/_missing" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("static file serving", () => {
  it("serves index.html for an unknown path so client routing works", async () => {
    const baseDeps = await makeBaseDeps();
    const webDir = await tempDir("hs-web-");
    await writeFile(
      join(webDir, "index.html"),
      "<!doctype html><title>hs</title>",
    );
    const app = await buildApp({ ...baseDeps, webDir });
    onTestFinished(() => app.close());
    const res = await app.inject({ method: "GET", url: "/exposures" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>hs</title>");
  });

  it("does not swallow an unknown API route", async () => {
    // The SPA fallback must not turn a missing endpoint into an HTML page —
    // a fetch would then fail on JSON parsing rather than on a 404.
    const baseDeps = await makeBaseDeps();
    const webDir = await tempDir("hs-web-");
    await writeFile(join(webDir, "index.html"), "<!doctype html>");
    const app = await buildApp({ ...baseDeps, webDir });
    onTestFinished(() => app.close());
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).not.toContain("text/html");
  });

  it("does not swallow a non-GET method on an unknown route", async () => {
    // A mistyped POST to an unknown path should not get an HTML page with a
    // 200 status — that's the least legible possible failure for a client.
    const baseDeps = await makeBaseDeps();
    const webDir = await tempDir("hs-web-");
    await writeFile(join(webDir, "index.html"), "<!doctype html>");
    const app = await buildApp({ ...baseDeps, webDir });
    onTestFinished(() => app.close());
    const res = await app.inject({ method: "POST", url: "/typo" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).not.toContain("text/html");
  });

  it("works with no webDir, as in development", async () => {
    const baseDeps = await makeBaseDeps();
    const app = await buildApp(baseDeps);
    onTestFinished(() => app.close());
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
  });
});
