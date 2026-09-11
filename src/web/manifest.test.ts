import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("points every declared icon at a file that actually exists in public/", () => {
    // A manifest that references an icon is not the same guarantee as the icon being
    // there: `rm public/icon.svg` left the suite green until this existed, and a missing
    // icon is exactly the failure that stops the install prompt from ever appearing.
    for (const icon of manifest.icons as Array<{ src: string }>) {
      expect(existsSync(join("public", icon.src))).toBe(true);
    }
  });

  it("is linked from index.html, since an unlinked manifest does nothing", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain('rel="manifest"');
    expect(html).toContain("manifest.webmanifest");
  });
});
