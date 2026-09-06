import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createAuth } from "./auth/index.js";
import { createDb, runMigrations } from "./db/client.js";

const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

async function boot() {
  const db = createDb(":memory:");
  await runMigrations(db);
  const auth = createAuth(db, TEST_AUTH);
  return buildApp({ db, auth });
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
    const quiet = await buildApp({ db, auth });
    const loud = await buildApp({ db, auth, logger: true });
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
      throw new Error("db at /var/lib/homestacks/homestacks.db is corrupt");
    });
    const res = await app.inject({ method: "GET", url: "/api/_boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    expect(res.body).not.toContain("/var/lib/homestacks");
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
