import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb, runMigrations } from "../db/client.js";
import { createAuth } from "./index.js";

// C2: Better-Auth only enables rate limiting when NODE_ENV === "production",
// and nothing in this project sets NODE_ENV, so sign-in accepted unlimited
// password guesses against a root-equivalent account. createAuth now sets the
// limits explicitly, exactly as it already does for `secret` and `baseURL`.
//
// This file is deliberately separate: Better-Auth's in-memory rate-limit store
// is module-level state, and Vitest isolates modules per test file, so the
// attempts spent here cannot starve the sign-ins in the other suites. For the
// same reason there is only one test below that actually spends attempts.
const TEST_AUTH = {
  secret: "test-secret-value-at-least-32-chars",
  baseURL: "http://localhost:7420",
};

async function boot() {
  const db = createDb(":memory:");
  await runMigrations(db);
  const auth = createAuth(db, TEST_AUTH);
  const app = await buildApp({ db, auth });
  await auth.api.signUpEmail({
    body: {
      email: "admin@example.com",
      password: "admin-password-123",
      name: "Admin",
    },
  });
  return { app, auth };
}

describe("sign-in rate limiting", () => {
  it("resolves to an enabled config rather than the disabled default", async () => {
    const { auth } = await boot();
    const ctx = await auth.$context;
    expect(ctx.rateLimit).toMatchObject({ enabled: true, window: 60, max: 60 });
    expect(ctx.rateLimit.customRules).toMatchObject({
      "/sign-in/email": { window: 60, max: 5 },
    });
    // No client-supplied header may be used as the rate-limit key.
    expect(ctx.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([]);
  });

  it("throttles repeated password guesses even when the client rotates x-forwarded-for", async () => {
    // Rotating the header on every request is the strongest form of the
    // attack: Better-Auth trusts x-forwarded-for by default with no
    // trusted-proxy list, which would hand the attacker a fresh bucket per
    // guess. createAuth clears ipAddressHeaders, so the limit still bites.
    const { app } = await boot();
    const guess = (ip: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { "x-forwarded-for": ip },
        payload: { email: "admin@example.com", password: "wrong-password-xx" },
      });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await guess(`10.0.0.${i}`)).statusCode);
    }

    // Five attempts are answered on their merits, the sixth is refused.
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);
  });
});
