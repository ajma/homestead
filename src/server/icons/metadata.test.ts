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
    // Typing "plex" should not surface "home-assistant" first because of some
    // incidental substring; the thing you typed the start of comes first.
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    const results = meta.search("home");
    expect(results[0]?.slug).toBe("home-assistant");
  });

  it("bounds the result count", async () => {
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.search("", 2).length).toBeLessThanOrEqual(2);
  });

  it("reports whether a slug is known, which is the SSRF guard other code depends on", async () => {
    const meta = new IconMetadata({ cacheDir: dir(), fetchImpl: fetchOk(UPSTREAM, { n: 0 }) });
    await meta.load();
    expect(meta.has("jellyfin")).toBe(true);
    expect(meta.has("../../etc/passwd")).toBe(false);
    expect(meta.has("https://evil.example/x")).toBe(false);
  });
});
