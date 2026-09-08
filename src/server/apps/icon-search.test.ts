import { describe, expect, it } from "vitest";
import { parseManifest, searchIcons, suggestSlug } from "./icon-search.js";

const NAMES = [
  "jellyfin",
  "jellyseerr",
  "sonarr",
  "radarr",
  "metube",
  "nextcloud",
  "1password-dark",
];

describe("parseManifest", () => {
  it("reads the png list and drops the extension", () => {
    // tree.json lists "metube.png"; every other part of the system speaks in
    // slugs, and the resolver appends .png itself.
    expect(
      parseManifest(JSON.stringify({ png: ["metube.png", "sonarr.png"] })),
    ).toEqual(["metube", "sonarr"]);
  });

  it("returns nothing for a manifest it cannot read", () => {
    // A box that has never reached the internet gets an empty picker, not an
    // error — the URL field still works and must keep working.
    expect(parseManifest("not json")).toEqual([]);
    expect(parseManifest(JSON.stringify({ svg: ["a.svg"] }))).toEqual([]);
  });
});

describe("searchIcons", () => {
  it("matches anywhere in the name, not just the start", () => {
    // "arr" is how someone finds sonarr and radarr together.
    expect(searchIcons(NAMES, "arr")).toEqual(
      expect.arrayContaining(["sonarr", "radarr"]),
    );
  });

  it("puts an exact match first", () => {
    // Typing the whole name and getting it third is the search failing.
    expect(searchIcons(NAMES, "sonarr")[0]).toBe("sonarr");
  });

  it("puts a prefix match ahead of a mid-word one", () => {
    const results = searchIcons(NAMES, "jelly");
    expect(results[0]).toBe("jellyfin");
  });

  it("ignores case", () => {
    expect(searchIcons(NAMES, "JELLYFIN")).toContain("jellyfin");
  });

  it("returns nothing for an empty query rather than everything", () => {
    // 2798 icons is not a useful answer to "".
    expect(searchIcons(NAMES, "")).toEqual([]);
    expect(searchIcons(NAMES, "   ")).toEqual([]);
  });

  it("caps the result list", () => {
    const many = Array.from({ length: 500 }, (_, i) => `thing-${i}`);
    expect(searchIcons(many, "thing").length).toBeLessThanOrEqual(25);
  });

  it("finds nothing when nothing matches", () => {
    expect(searchIcons(NAMES, "zzzz")).toEqual([]);
  });
});

describe("suggestSlug", () => {
  it("suggests the project's own slug when the set has it", () => {
    // metube -> metube.png. Most self-hosted projects are named after the app.
    expect(suggestSlug(NAMES, "metube")).toBe("metube");
  });

  it("suggests nothing rather than a near miss", () => {
    // A wrong icon chosen on the operator's behalf is worse than none: it
    // looks deliberate, so nobody goes looking for why it is wrong.
    expect(suggestSlug(NAMES, "my-notes-app")).toBeNull();
  });

  it("ignores case and surrounding whitespace", () => {
    expect(suggestSlug(NAMES, "  Sonarr ")).toBe("sonarr");
  });
});
