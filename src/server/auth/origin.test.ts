import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { tempDir } from "../test-support/tmp.js";
import { type Auth, createAuth } from "./index.js";

// C1: Better-Auth validates the browser's Origin header against baseURL plus
// trustedOrigins. When baseURL was hardcoded to http://localhost:${port}, every
// sign-in from a real deployment address was answered with 403 INVALID_ORIGIN,
// which is why baseURL is now configuration (HOMESTEAD_BASE_URL).
const LAN_ORIGIN = "http://192.168.1.50:7420";
const CREDENTIALS = {
  email: "admin@example.com",
  password: "admin-password-123",
};

let db: Db;
let auth: Auth;
let app: Awaited<ReturnType<typeof buildApp>>;

async function bootAt(baseURL: string): Promise<void> {
  db = createDb(":memory:");
  await runMigrations(db);
  auth = createAuth(db, {
    secret: "test-secret-value-at-least-32-chars",
    baseURL,
  });
  const tmpDir = await tempDir("hs-test-");
  app = await buildApp({
    db,
    auth,
    projectsDir: tmpDir,
    projectsHostDir: tmpDir,
    dataDir: tmpDir,
  });
  await auth.api.signUpEmail({ body: { ...CREDENTIALS, name: "Admin" } });
}

function signIn(origin: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin, host: new URL(origin).host },
    payload: CREDENTIALS,
  });
}

describe("origin validation follows the configured baseURL", () => {
  it("accepts a sign-in whose Origin matches a non-localhost baseURL", async () => {
    await bootAt(LAN_ORIGIN);
    const res = await signIn(LAN_ORIGIN);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("INVALID_ORIGIN");
  });

  it("still rejects an Origin that matches neither baseURL nor trustedOrigins", async () => {
    await bootAt(LAN_ORIGIN);
    const res = await signIn("http://evil.example.com");
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("INVALID_ORIGIN");
  });
});

describe("the localhost default is what broke real deployments", () => {
  beforeEach(async () => {
    // Reproduces the pre-fix configuration: baseURL pinned to localhost while
    // the operator browses to the machine's LAN address.
    await bootAt("http://localhost:7420");
  });

  it("rejects a LAN Origin when baseURL is left at the localhost default", async () => {
    const res = await signIn(LAN_ORIGIN);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("INVALID_ORIGIN");
  });
});
