import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import type { Capability } from "@shared/capabilities";
import type { Role } from "@shared/types";
import { describe, expect, it, vi } from "vitest";

/**
 * Simulates the moment `cf:read` is first granted to a role that doesn't also carry
 * `cf:write` — a combination the real capability table (`src/shared/capabilities.ts`)
 * never produces today: `admin` holds every capability and `viewer` holds none of these
 * four, so nothing exercises the asymmetry the whole-branch review flagged — `GET
 * /api/cloudflare/zones` stayed on `cf:write` after its sibling status read moved to
 * `cf:read`, and all four routes 403 a viewer identically either way. Mocked here rather
 * than added as a real role, since a synthetic "read-only Cloudflare" role is not
 * something this phase's spec asks for; only the consistency between the two read routes
 * is worth pinning.
 */
vi.mock("@shared/capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/capabilities")>();
  return {
    ...actual,
    roleHas: (role: Role, capability: Capability) =>
      role === "viewer" && capability === "cf:read" ? true : actual.roleHas(role, capability),
  };
});

describe("cf:read vs cf:write", () => {
  it("a role holding only cf:read can read both credentials status and zones, but still can't write", async () => {
    const app = await buildTestApp();
    const { cookie: adminCookie } = await signUpAdmin(app);
    app.deps.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: [{ id: "z1", name: "example.com" }],
          result_info: { page: 1, per_page: 50, total_count: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie: adminCookie },
      payload: { token: "cfat_x", accountId: "acct-1" },
    });

    const { cookie } = await createViewer(app, adminCookie);

    const statusRes = await app.inject({
      method: "GET",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });
    const zonesRes = await app.inject({
      method: "GET",
      url: "/api/cloudflare/zones",
      headers: { cookie },
    });
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
      payload: { token: "whatever", accountId: "whatever" },
    });
    const deleteRes = await app.inject({
      method: "DELETE",
      url: "/api/cloudflare/credentials",
      headers: { cookie },
    });

    // Both READ routes honour cf:read the same way...
    expect(statusRes.statusCode).toBe(200);
    expect(zonesRes.statusCode).toBe(200);
    // ...and both WRITE routes still refuse a cf:read-only caller.
    expect(putRes.statusCode).toBe(403);
    expect(deleteRes.statusCode).toBe(403);

    await app.close();
  });
});
