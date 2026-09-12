import { apps } from "@server/db/schema";
import { buildTestApp, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

describe("app scope enforcement", () => {
  // Every route that loads an app by id must respect the scope predicate. A scoped
  // principal with an empty allowlist should get 404 from all of them, not 403 (which
  // would confirm that an app they may not see exists), and never a body carrying secrets.

  const ROUTES: Array<{
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    desc: string;
    payload?: Record<string, unknown>;
  }> = [
    { method: "GET", path: "/api/apps/:id", desc: "detail" },
    { method: "PATCH", path: "/api/apps/:id", desc: "update", payload: { displayName: "New" } },
    { method: "DELETE", path: "/api/apps/:id", desc: "delete" },
    { method: "GET", path: "/api/apps/:id/compose", desc: "read compose" },
    {
      method: "PUT",
      path: "/api/apps/:id/compose",
      desc: "write compose",
      payload: { content: "services: {}\n", expectedHash: null },
    },
    {
      method: "POST",
      path: "/api/apps/:id/compose/validate",
      desc: "validate compose",
      payload: { content: "services: {}\n" },
    },
    { method: "GET", path: "/api/apps/:id/env", desc: "read env" },
    { method: "POST", path: "/api/apps/:id/env/reveal", desc: "reveal env" },
    {
      method: "PUT",
      path: "/api/apps/:id/env",
      desc: "write env",
      payload: { content: "FOO=bar\n", expectedHash: null },
    },
  ];

  for (const route of ROUTES) {
    it(`${route.method} ${route.path} (${route.desc}) returns 404 for out-of-scope app`, async () => {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);

      // Adopt an app as the admin.
      app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
      app.deps.host.composeResults.set("config --format json", {
        exitCode: 0,
        stdout: JSON.stringify({ name: "jellyfin", services: {} }),
        stderr: "",
      });
      const adopted = await app.inject({
        method: "POST",
        url: "/api/apps/adopt",
        headers: { cookie },
        payload: { directories: ["jellyfin"] },
      });
      const appId = adopted.json().adopted[0].id;

      // Create a scoped admin with an empty allowlist.
      const scopedEmail = `scoped-${Math.random().toString(36).slice(2)}@example.com`;
      await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie },
        payload: {
          email: scopedEmail,
          password: "correct-horse-battery",
          name: "Scoped Admin",
          role: "admin",
          scopeAllApps: false,
          appIds: [],
        },
      });
      const signIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        payload: { email: scopedEmail, password: "correct-horse-battery" },
      });
      const scopedCookie = String(signIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";

      const res = await app.inject({
        method: route.method,
        url: route.path.replace(":id", appId),
        headers: { cookie: scopedCookie },
        payload: route.payload,
      });

      // Out of scope is 404, not 403, so the response does not confirm an app exists.
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
      // Never leak secrets in the body.
      expect(JSON.stringify(res.json())).not.toContain("hunter2");

      await app.close();
    });
  }

  it("tells a scoped admin nothing about a system app outside their scope", async () => {
    // `DELETE /api/apps/:id` checks scope (via `loadApp`) before it checks `systemKind`
    // (`apps.ts:626`), so an out-of-scope system app 404s today, by construction —
    // never 409, which would confirm to a scoped admin that an app they cannot see
    // exists at all. Nothing else pins that ordering: a refactor that hoisted the
    // `systemKind` check above `loadApp` would turn this into a 409 and nothing would
    // notice.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);

    // Adopt a system app as the admin.
    app.deps.host.files.set("cloudflared/compose.yaml", "services: {}\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "cloudflared", services: {} }),
      stderr: "",
    });
    const adopted = await app.inject({
      method: "POST",
      url: "/api/apps/adopt",
      headers: { cookie },
      payload: { directories: ["cloudflared"] },
    });
    const appId = adopted.json().adopted[0].id;
    await app.deps.db.update(apps).set({ systemKind: "self" }).where(eq(apps.id, appId));

    // Create a scoped admin with an empty allowlist — cannot see the system app above.
    const scopedEmail = `scoped-${Math.random().toString(36).slice(2)}@example.com`;
    await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie },
      payload: {
        email: scopedEmail,
        password: "correct-horse-battery",
        name: "Scoped Admin",
        role: "admin",
        scopeAllApps: false,
        appIds: [],
      },
    });
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: scopedEmail, password: "correct-horse-battery" },
    });
    const scopedCookie = String(signIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";

    const res = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}`,
      headers: { cookie: scopedCookie },
    });

    // 404 — never 409. A 409 confirms the app exists.
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });

    await app.close();
  });
});
