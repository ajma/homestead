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

  it("requires authentication, so an anonymous request cannot drive an outbound fetch", async () => {
    // This is the route that reaches the internet — the one an anonymous caller reaching
    // it would let them repeatedly drive an outbound CDN request from the NAS.
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/icons/jellyfin.svg" });
    expect(res.statusCode).toBe(401);
  });

  it("serves a known icon as SVG, cacheable but not immutable", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/icons/jellyfin.svg",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    expect(res.headers["cache-control"]).toContain("max-age=86400");
    // A slug is addressed by name, not content: upstream can replace the file. With
    // `immutable` a single wrong icon sticks in every viewer's browser for the whole
    // max-age with no server-side lever, and "clear your site data" is not an
    // instruction you can give a housemate.
    expect(res.headers["cache-control"]).not.toContain("immutable");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
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
    // Pin the 404 against a *working* store in the same test. On its own this case
    // passes just as happily against a store that returns null for everything, which
    // would also 404 the icons that do exist.
    const known = await app.inject({
      method: "GET",
      url: "/api/icons/jellyfin.svg",
      headers: { cookie },
    });
    expect(known.statusCode).toBe(200);
  });

  it("400s an unrecognised variant rather than reaching for a file", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/icons/jellyfin.svg?variant=blue",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
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
    // Same reason as the 404 test above: a store that refused everything would satisfy
    // the loop without the guards existing at all.
    const known = await app.inject({
      method: "GET",
      url: "/api/icons/jellyfin.svg",
      headers: { cookie },
    });
    expect(known.statusCode).toBe(200);
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
