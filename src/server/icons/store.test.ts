import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IconMetadata } from "@server/icons/metadata";
import { IconStore } from "@server/icons/store";
import { describe, expect, it } from "vitest";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';

async function loaded(cacheDir: string) {
  const metadata = new IconMetadata({
    cacheDir,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ jellyfin: { base: ["svg"], aliases: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });
  await metadata.load();
  return metadata;
}

describe("IconStore", () => {
  it("fetches an icon once and serves the second request from disk", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    let calls = 0;
    const store = new IconStore({
      cacheDir,
      metadata: await loaded(cacheDir),
      fetchImpl: (async () => {
        calls++;
        return new Response(SVG, { status: 200, headers: { "content-type": "image/svg+xml" } });
      }) as unknown as typeof fetch,
    });
    expect((await store.fetchIcon("jellyfin", null))?.toString()).toBe(SVG);
    expect((await store.fetchIcon("jellyfin", null))?.toString()).toBe(SVG);
    expect(calls).toBe(1);
  });

  it("refuses a slug that is not in the index, so a slug cannot become an SSRF", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    let calls = 0;
    const store = new IconStore({
      cacheDir,
      metadata: await loaded(cacheDir),
      fetchImpl: (async () => {
        calls++;
        return new Response(SVG, { status: 200 });
      }) as unknown as typeof fetch,
    });
    for (const evil of [
      "../../etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "https://evil.example/payload.svg",
      "unknown-app",
      "jellyfin/../../../root",
    ]) {
      expect(await store.fetchIcon(evil, null)).toBeNull();
    }
    expect(calls).toBe(0);
  });

  it("writes nothing outside the cache directory", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    const store = new IconStore({
      cacheDir,
      metadata: await loaded(cacheDir),
      fetchImpl: (async () => new Response(SVG, { status: 200 })) as unknown as typeof fetch,
    });
    await store.fetchIcon("jellyfin", null);
    await store.fetchIcon("../escape", null);
    for (const name of readdirSync(cacheDir)) {
      expect(name.includes("..")).toBe(false);
    }
    expect(existsSync(join(cacheDir, "..", "escape.svg"))).toBe(false);
  });

  it("returns null rather than throwing when upstream is unreachable", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    const store = new IconStore({
      cacheDir,
      metadata: await loaded(cacheDir),
      fetchImpl: (async () => {
        throw new Error("ENETUNREACH");
      }) as unknown as typeof fetch,
    });
    expect(await store.fetchIcon("jellyfin", null)).toBeNull();
  });

  it("refuses an oversized download rather than buffering and serving it", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    const store = new IconStore({
      cacheDir,
      metadata: await loaded(cacheDir),
      fetchImpl: (async () =>
        new Response("a".repeat(600 * 1024), {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        })) as unknown as typeof fetch,
    });
    expect(await store.fetchIcon("jellyfin", null)).toBeNull();
    // A failed download must not leave a truncated file behind for the next request to
    // serve as if it were the real icon.
    expect(readdirSync(cacheDir).filter((name) => name.endsWith(".svg"))).toEqual([]);
  });

  it("caches light and dark variants separately", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    let calls = 0;
    const store = new IconStore({
      cacheDir,
      metadata: await loaded(cacheDir),
      fetchImpl: (async () => {
        calls++;
        return new Response(SVG, { status: 200 });
      }) as unknown as typeof fetch,
    });
    await store.fetchIcon("jellyfin", "light");
    await store.fetchIcon("jellyfin", "dark");
    expect(calls).toBe(2);
  });
});
