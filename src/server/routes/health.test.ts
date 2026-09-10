import { buildTestApp } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("reports ok with a version", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    await app.close();
  });

  it("returns a JSON 404 for an unknown API route", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    await app.close();
  });
});
