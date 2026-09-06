import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createAuth } from "./auth/index.js";
import { createDb, runMigrations } from "./db/client.js";

const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

describe("app", () => {
  it("responds to the health check", async () => {
    const db = createDb(":memory:");
    await runMigrations(db);
    const auth = createAuth(db, TEST_AUTH);
    const app = await buildApp({ db, auth });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
