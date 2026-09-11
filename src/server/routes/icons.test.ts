import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

describe("icon routes", () => {
  it("searches by slug and alias for any signed-in user", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "GET",
      url: "/api/icons/search?q=jelly",
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().icons[0].slug).toBe("jellyfin");
  });

  it("requires authentication, so the catalogue is not an open endpoint", async () => {
    const app = await buildTestApp();
    expect((await app.inject({ method: "GET", url: "/api/icons/search?q=a" })).statusCode).toBe(
      401,
    );
  });

  it("serves a known icon as SVG with a long cache header", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/icons/jellyfin.svg",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    expect(res.headers["cache-control"]).toContain("max-age=");
  });

  it("404s an unknown slug with an error slug", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/icons/not-a-real-icon.svg",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("rejects a traversal attempt in the slug", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    for (const evil of ["..%2f..%2fetc%2fpasswd", "..", "JELLYFIN"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/icons/${evil}.svg`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("bounds the search limit so a caller cannot ask for the whole 1.15 MB index", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/icons/search?q=&limit=9999",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });
});
