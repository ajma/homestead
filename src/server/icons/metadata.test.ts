import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IconMetadata } from "@server/icons/metadata";
import { describe, expect, it } from "vitest";

const UPSTREAM = {
  jellyfin: { base: ["svg"], aliases: ["emby"], categories: ["media"], colors: {} },
  "home-assistant": { base: ["svg"], aliases: [], categories: ["automation"], colors: {} },
  plex: { base: ["svg", "png"], aliases: [], categories: ["media"], colors: {} },
};

// Fixture for the ranking tests below. Slugs are chosen so that a naive alphabetical
// sort (i.e. the scoring deleted) gives the *wrong* order, so the assertions only pass
// when the score actually drives the sort:
//  - "epho" sorts before "photon" alphabetically, but "photon" is a prefix match for
//    "pho" while "epho" is only a substring match, so the correct order is reversed
//    from alphabetical.
//  - "embydeck" sorts before "jellyfinx" alphabetically, but "jellyfinx" is an exact
//    alias match for "emby" while "embydeck" is only a prefix match on its slug.
const RANKING = {
  photon: { base: ["svg"], aliases: [], categories: [], colors: {} },
  epho: { base: ["svg"], aliases: [], categories: [], colors: {} },
  jellyfinx: { base: ["svg"], aliases: ["emby"], categories: [], colors: {} },
  embydeck: { base: ["svg"], aliases: [], categories: [], colors: {} },
};

function dir() {
  return mkdtempSync(join(tmpdir(), "homestead-icons-"));
}

function fetchOk(body: unknown, calls: { n: number }) {
  return (async () => {
    calls.n++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function fetchBody(body: string, calls: { n: number } = { n: 0 }) {
  return (async () => {
    calls.n++;
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("IconMetadata", () => {
  it("fetches, indexes, and writes the payload to disk", async () => {
    const cacheDir = dir();
    const calls = { n: 0 };
    const meta = new IconMetadata({ cacheDir, fetchImpl: fetchOk(UPSTREAM, calls) });
    await meta.load();
    expect(meta.size).toBe(3);
    expect(calls.n).toBe(1);
    expect(JSON.parse(readFileSync(join(cacheDir, "metadata.json"), "utf8"))).toEqual(UPSTREAM);
  });

  it("serves from disk when the network is down — the outage case the spec names", async () => {
    const cacheDir = dir();
    writeFileSync(join(cacheDir, "metadata.json"), JSON.stringify(UPSTREAM));
    const meta = new IconMetadata({
      cacheDir,
      fetchImpl: (async () => {
        throw new Error("ENETUNREACH");
      }) as unknown as typeof fetch,
    });
    await meta.load();
    expect(meta.size).toBe(3);
    expect(meta.search("jelly")[0]?.slug).toBe("jellyfin");
  });

  it("degrades to an empty index rather than throwing when there is no cache and no network", async () => {
    // The launcher must still render. Letter tiles are the fallback, and an icon
    // service that throws on boot would take the whole server down with it.
    const meta = new IconMetadata({
      cacheDir: dir(),
      fetchImpl: (async () => {
        throw new Error("ENETUNREACH");
      }) as unknown as typeof fetch,
    });
    await expect(meta.load()).resolves.toBeUndefined();
    expect(meta.size).toBe(0);
    expect(meta.search("jelly")).toEqual([]);
  });

  it("survives a corrupt cache file instead of crashing on boot", async () => {
    const cacheDir = dir();
    writeFileSync(join(cacheDir, "metadata.json"), "{ this is not json");
    const meta = new IconMetadata({
      cacheDir,
      fetchImpl: (async () => {
        throw new Error("ENETUNREACH");
      }) as unknown as typeof fetch,
    });
    await expect(meta.load()).resolves.toBeUndefined();
    expect(meta.size).toBe(0);
  });

  it("matches on alias as well as slug", async () => {
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.search("emby")[0]?.slug).toBe("jellyfin");
  });

  it("ranks a prefix match above a substring match", async () => {
    // "photon" starts with "pho" (prefix match); "epho" only contains "pho" partway
    // through (substring match). Alphabetically "epho" < "photon", so this only
    // passes if the score — not the slug — is driving the sort.
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(RANKING, { n: 0 }) });
    await meta.load();
    const results = meta.search("pho");
    const prefixIndex = results.findIndex((r) => r.slug === "photon");
    const substringIndex = results.findIndex((r) => r.slug === "epho");
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    expect(substringIndex).toBeGreaterThanOrEqual(0);
    expect(prefixIndex).toBeLessThan(substringIndex);
  });

  it("ranks an exact match above a prefix match", async () => {
    // "jellyfinx" has the exact alias "emby"; "embydeck" only has a slug that starts
    // with "emby" (prefix match). Alphabetically "embydeck" < "jellyfinx", so this
    // only passes if the exact match is scored above the prefix match.
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(RANKING, { n: 0 }) });
    await meta.load();
    const results = meta.search("emby");
    expect(results[0]?.slug).toBe("jellyfinx");
  });

  it("bounds the result count", async () => {
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.search("", 2).length).toBeLessThanOrEqual(2);
  });

  it("clamps a negative limit instead of returning almost everything", async () => {
    // slice(0, limit) treats a negative limit as length + limit, so search("", -1)
    // on a large index would otherwise return nearly all of it.
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.search("", -1)).toEqual([]);
    expect(meta.search("home", -1)).toEqual([]);
  });

  it("clamps a zero limit to no results", async () => {
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.search("", 0)).toEqual([]);
    expect(meta.search("home", 0)).toEqual([]);
  });

  it("clamps a non-integer limit down instead of erroring", async () => {
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.search("", 2.9).length).toBe(2);
    expect(meta.search("", 0.5)).toEqual([]);
  });

  it("reports whether a slug is known, which is the SSRF guard other code depends on", async () => {
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.has("jellyfin")).toBe(true);
    expect(meta.has("../../etc/passwd")).toBe(false);
    expect(meta.has("https://evil.example/x")).toBe(false);
  });

  it("treats __proto__, constructor, and other prototype-shaped keys as ordinary unknown slugs", async () => {
    // Object.entries surfaces these as ordinary own keys of parsed JSON, and `has`
    // consults a real Set — there is no prototype-pollution path — but that exactness
    // deserves its own coverage, since `has` is the SSRF guard other code relies on.
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.has("__proto__")).toBe(false);
    expect(meta.has("constructor")).toBe(false);
    expect(meta.has("")).toBe(false);
    expect(meta.has("jelly fin")).toBe(false);
    expect(meta.has("jelly\nfin")).toBe(false);
    expect(meta.has("jelly\0fin")).toBe(false);
  });

  it("degrades to an empty index instead of rejecting when the network is oversized", async () => {
    // The real file is 1.15 MB; anything over the 4 MB cap is treated as a failed
    // fetch, the same way IconStore already caps its own icon downloads. The padding
    // lives in an otherwise-valid plain-object payload (not an array) so this proves
    // the size bound specifically, rather than being caught by the array rejection.
    const oversized = `{"pad": "${"1".repeat(5 * 1024 * 1024)}"}`;
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchBody(oversized) });
    await expect(meta.load()).resolves.toBeUndefined();
    expect(meta.size).toBe(0);
  });

  it("falls back to the disk cache when the network response is oversized", async () => {
    const cacheDir = dir();
    writeFileSync(join(cacheDir, "metadata.json"), JSON.stringify(UPSTREAM));
    const oversized = `{"pad": "${"1".repeat(5 * 1024 * 1024)}"}`;
    const meta = new IconMetadata({ cacheDir, fetchImpl: fetchBody(oversized) });
    await meta.load();
    expect(meta.size).toBe(3);
  });

  it("rejects a JSON array response instead of fabricating numeric slugs", async () => {
    // typeof [] === "object", so a plain-object guard alone lets an array response
    // build an index of icons named "0", "1", ... that then survives to disk.
    const meta = new IconMetadata({
      cacheDir: dir(),
      fetchImpl: fetchOk(["jellyfin", "plex"], { n: 0 }),
    });
    await expect(meta.load()).resolves.toBeUndefined();
    expect(meta.size).toBe(0);
    expect(meta.has("0")).toBe(false);
  });

  it("rejects a bare JSON string response", async () => {
    const meta = new IconMetadata({
      cacheDir: dir(),
      fetchImpl: fetchOk("not an index", { n: 0 }),
    });
    await expect(meta.load()).resolves.toBeUndefined();
    expect(meta.size).toBe(0);
  });
});
