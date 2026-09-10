import { buildTestApp, signUpAdmin } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

describe("launchInternalUrl validation", () => {
  async function adoptApp() {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
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
    return { app, cookie, id: adopted.json().adopted[0].id as string };
  }

  it("rejects javascript: scheme to prevent XSS", async () => {
    const { app, cookie, id } = await adoptApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${id}`,
      headers: { cookie },
      payload: { launchInternalUrl: "javascript:alert(document.cookie)" },
    });
    expect(res.statusCode).toBe(400);
    // Zod validation error - the key outcome is 400, not the specific error slug.
    expect(res.json().error).toMatch(/invalid_url|validation_failed/);
    await app.close();
  });

  it("rejects data: scheme", async () => {
    const { app, cookie, id } = await adoptApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${id}`,
      headers: { cookie },
      payload: { launchInternalUrl: "data:text/html,<script>alert(1)</script>" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid_url|validation_failed/);
    await app.close();
  });

  it("rejects scheme-relative URLs", async () => {
    const { app, cookie, id } = await adoptApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${id}`,
      headers: { cookie },
      payload: { launchInternalUrl: "//evil.example/redirect" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid_url|validation_failed/);
    await app.close();
  });

  it("accepts http URLs", async () => {
    const { app, cookie, id } = await adoptApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${id}`,
      headers: { cookie },
      payload: { launchInternalUrl: "http://nas.local:8096" },
    });
    expect(res.statusCode).toBe(200);
    // The DTO returns launchUrl (viewer-facing name), sourced from launchInternalUrl.
    expect(res.json().launchUrl).toBe("http://nas.local:8096");
    await app.close();
  });

  it("accepts https URLs", async () => {
    const { app, cookie, id } = await adoptApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${id}`,
      headers: { cookie },
      payload: { launchInternalUrl: "https://jellyfin.example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().launchUrl).toBe("https://jellyfin.example.com");
    await app.close();
  });

  it("accepts null to clear the URL", async () => {
    const { app, cookie, id } = await adoptApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/apps/${id}`,
      headers: { cookie },
      payload: { launchInternalUrl: null },
    });
    expect(res.statusCode).toBe(200);
    // Database stores null, which may serialize as null or be omitted.
    const url = res.json().launchUrl;
    expect(url === null || url === undefined).toBe(true);
    await app.close();
  });
});
