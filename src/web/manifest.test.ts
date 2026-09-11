import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PWA manifest", () => {
  const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));

  it("declares standalone display so it opens as an app, not a tab", () => {
    expect(manifest.display).toBe("standalone");
  });

  it("starts at the launcher, which is the only route every user has", () => {
    expect(manifest.start_url).toBe("/");
  });

  it("declares at least one icon, or the install prompt never appears", () => {
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it("is linked from index.html, since an unlinked manifest does nothing", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain('rel="manifest"');
    expect(html).toContain("manifest.webmanifest");
  });
});
