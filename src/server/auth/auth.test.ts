import { sessions, users } from "@server/db/schema";
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

  it("records the real peer, not a forged forwarded chain, as the session IP", async () => {
    const app = await buildTestApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      // An untrusted LAN peer appends a trusted proxy to the chain. Before the header
      // strip in app.ts, Better-Auth persisted 203.0.113.99 here.
      remoteAddress: "192.168.1.50",
      headers: { "x-forwarded-for": "203.0.113.99, 127.0.0.1", "cf-connecting-ip": "198.51.100.7" },
      payload: { email: "lan@example.com", password: "correct-horse-battery", name: "Lan" },
    });
    const [session] = await app.deps.db.select().from(sessions);
    expect(session?.ipAddress).toBe("192.168.1.50");
    await app.close();
  });

  it("still resolves an IP for a loopback client", async () => {
    const app = await buildTestApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      remoteAddress: "127.0.0.1",
      // Simulate cloudflared (trusted proxy) providing the real client IP via x-forwarded-for
      headers: { "x-forwarded-for": "192.168.1.100" },
      payload: { email: "local@example.com", password: "correct-horse-battery", name: "Local" },
    });
    const [session] = await app.deps.db.select().from(sessions);
    // Must not be null: a null IP drops Better-Auth's rate limiter into one shared bucket.
    expect(session?.ipAddress).toBe("192.168.1.100");
    await app.close();
  });

  it("does not mark cookies Secure when the base URL is plain HTTP", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "lan2@example.com", password: "correct-horse-battery", name: "Lan2" },
    });
    const cookies = String(res.headers["set-cookie"]);
    expect(cookies.toLowerCase()).not.toContain("secure");
    await app.close();
  });
});
