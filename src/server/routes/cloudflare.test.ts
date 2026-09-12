import { auditLog } from "@server/db/schema";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const TOKEN = "cfat_super-secret-token-value";
const ACCOUNT_ID = "acct-123";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function successEnvelope(zones: Array<{ id: string; name: string }>) {
  return {
    success: true,
    errors: [],
    result: zones,
    result_info: { page: 1, per_page: 50, count: zones.length, total_count: zones.length },
  };
}

function failureEnvelope(code: number, message: string) {
  return { success: false, errors: [{ code, message }], result: null };
}

/** A `fetch` that always answers a successful `GET /zones` with one fixed zone. */
function verifyingFetch(
  zones: Array<{ id: string; name: string }> = [{ id: "z1", name: "example.com" }],
) {
  return (async () => jsonResponse(successEnvelope(zones))) as unknown as typeof fetch;
}

/** A `fetch` that always answers 401 (an invalid token). */
function failingFetch(status = 401, code = 9109, message = "Invalid access token") {
  return (async () =>
    jsonResponse(failureEnvelope(code, message), { status })) as unknown as typeof fetch;
}

async function withAdmin() {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  return { app, cookie };
}

describe("cloudflare routes", () => {
  it("PUT verifies by listing zones, stores on success, and returns the status", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = verifyingFetch();

    const res = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      configured: true,
      accountId: ACCOUNT_ID,
      tokenHint: TOKEN.slice(-4),
    });
    await app.close();
  });

  it("does not store a token that fails verification", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = failingFetch();

    const putRes = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    expect(putRes.statusCode).toBe(422);

    const statusRes = await app.inject({
      method: "GET",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });
    expect(statusRes.json()).toEqual({ configured: false });
    await app.close();
  });

  it("surfaces the fault from a failed verification", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = failingFetch(401);

    const authRes = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    expect(authRes.json()).toMatchObject({ fault: "auth" });

    app.deps.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.cloudflare.com");
    }) as unknown as typeof fetch;
    const networkRes = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    expect(networkRes.json()).toMatchObject({ fault: "network" });
    await app.close();
  });

  it("trims whitespace pasted around the token and account id before verifying and storing", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = verifyingFetch();

    const res = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      // A trailing newline is the most likely way a copy-pasted, otherwise-valid token
      // gets rejected — invisible in a `type="password"` field.
      payload: { token: `${TOKEN}\n`, accountId: ` ${ACCOUNT_ID} ` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountId: ACCOUNT_ID, tokenHint: TOKEN.slice(-4) });
    await app.close();
  });

  it("GET credentials never returns the token", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = verifyingFetch();
    await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });
    expect(res.body).not.toContain(TOKEN);
    expect(JSON.stringify(res.json())).not.toContain(TOKEN);
    await app.close();
  });

  it("GET zones returns zones when configured", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = verifyingFetch([
      { id: "z1", name: "one.example" },
      { id: "z2", name: "two.example" },
    ]);
    await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/zones",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: "z1", name: "one.example" },
      { id: "z2", name: "two.example" },
    ]);
    await app.close();
  });

  it("GET zones returns a clean error when not configured, not a 500", async () => {
    const { app, cookie } = await withAdmin();

    const res = await app.inject({
      method: "GET",
      url: "/api/cloudflare/zones",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.statusCode).not.toBe(500);
    expect(res.json()).toMatchObject({ error: "not_configured" });
    await app.close();
  });

  it("gives a viewer 403 on all four routes, revealing nothing about configuration", async () => {
    const { app, cookie: adminCookie } = await withAdmin();
    app.deps.fetch = verifyingFetch();
    await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie: adminCookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    const { cookie } = await createViewer(app, adminCookie);

    const getRes = await app.inject({
      method: "GET",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: "whatever", accountId: "whatever" },
    });
    const zonesRes = await app.inject({
      method: "GET",
      url: "/api/cloudflare/zones",
      headers: { cookie },
    });
    const deleteRes = await app.inject({
      method: "DELETE",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });

    for (const res of [getRes, putRes, zonesRes, deleteRes]) {
      expect(res.statusCode).toBe(403);
      const body = JSON.stringify(res.json());
      expect(body).not.toContain(ACCOUNT_ID);
      expect(body).not.toContain("configured");
      expect(body).not.toContain(TOKEN);
    }
    await app.close();
  });

  it("writes an audit row for every mutation, without the token", async () => {
    const { app, cookie } = await withAdmin();
    app.deps.fetch = verifyingFetch();

    await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: TOKEN, accountId: ACCOUNT_ID },
    });
    await app.inject({
      method: "DELETE",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });

    const rows = await app.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "cloudflare.credentials_saved"));
    expect(rows).toHaveLength(1);

    const deleteRows = await app.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "cloudflare.credentials_deleted"));
    expect(deleteRows).toHaveLength(1);

    const allRows = await app.deps.db.select().from(auditLog);
    const serialised = JSON.stringify(allRows);
    expect(serialised).not.toContain(TOKEN);
    await app.close();
  });
});
