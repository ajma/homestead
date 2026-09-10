import { users } from "@server/db/schema";
import { buildTestApp } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

describe("authentication", () => {
  it("signs a user up and issues a session cookie", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "ada@example.com", password: "correct-horse-battery", name: "Ada" },
    });
    expect(res.statusCode).toBeLessThan(400);
    expect(res.headers["set-cookie"]).toBeDefined();
    await app.close();
  });

  it("ignores a role supplied in the sign-up body", async () => {
    const app = await buildTestApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        email: "mallory@example.com",
        password: "correct-horse-battery",
        name: "Mallory",
        role: "admin",
      },
    });
    const [row] = await app.deps.db.select().from(users);
    expect(row?.role).toBe("viewer");
    await app.close();
  });

  it("rejects a wrong password", async () => {
    const app = await buildTestApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "ada@example.com", password: "correct-horse-battery", name: "Ada" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "ada@example.com", password: "wrong" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it("does not mark cookies Secure when the base URL is plain HTTP", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "lan@example.com", password: "correct-horse-battery", name: "Lan" },
    });
    const cookies = String(res.headers["set-cookie"]);
    expect(cookies.toLowerCase()).not.toContain("secure");
    await app.close();
  });
});
