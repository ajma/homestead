import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "../test-support/tmp.js";
import { loadIconNames, MANIFEST_FILE } from "./icon-manifest.js";

const body = JSON.stringify({ png: ["metube.png", "sonarr.png"] });
const ok = () =>
  new Response(body, { status: 200, headers: { "content-type": "text/json" } });

describe("loadIconNames", () => {
  it("fetches and caches when there is nothing on disk", async () => {
    const cacheDir = await tempDir("hs-icons-");
    const f = vi.fn<typeof fetch>(async () => ok());

    await expect(loadIconNames({ cacheDir, fetch: f })).resolves.toEqual([
      "metube",
      "sonarr",
    ]);
    expect(f).toHaveBeenCalledOnce();
    expect(await readFile(join(cacheDir, MANIFEST_FILE), "utf8")).toBe(body);
  });

  it("reads the cache without fetching while it is fresh", async () => {
    // 200 KB on every keystroke of a search box would be absurd.
    const cacheDir = await tempDir("hs-icons-");
    await writeFile(join(cacheDir, MANIFEST_FILE), body);
    const f = vi.fn<typeof fetch>(async () => ok());

    await expect(loadIconNames({ cacheDir, fetch: f })).resolves.toEqual([
      "metube",
      "sonarr",
    ]);
    expect(f).not.toHaveBeenCalled();
  });

  it("refetches once the cache is old", async () => {
    const cacheDir = await tempDir("hs-icons-");
    await writeFile(join(cacheDir, MANIFEST_FILE), JSON.stringify({ png: [] }));
    const f = vi.fn<typeof fetch>(async () => ok());

    const names = await loadIconNames({
      cacheDir,
      fetch: f,
      now: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    expect(f).toHaveBeenCalledOnce();
    expect(names).toEqual(["metube", "sonarr"]);
  });

  it("keeps using a stale cache when the fetch fails", async () => {
    // A NAS that loses its internet keeps the picker it last had. Throwing
    // away known-good data because a refresh failed is the worse outcome.
    const cacheDir = await tempDir("hs-icons-");
    await writeFile(join(cacheDir, MANIFEST_FILE), body);
    const f = vi.fn<typeof fetch>(async () => {
      throw new Error("ENETUNREACH");
    });

    await expect(
      loadIconNames({
        cacheDir,
        fetch: f,
        now: Date.now() + 30 * 24 * 60 * 60 * 1000,
      }),
    ).resolves.toEqual(["metube", "sonarr"]);
  });

  it("returns nothing, and does not throw, with no cache and no network", async () => {
    // The picker is empty; the URL field still works. An error here would
    // break a form over a decoration.
    const cacheDir = await tempDir("hs-icons-");
    const f = vi.fn<typeof fetch>(async () => {
      throw new Error("ENETUNREACH");
    });
    await expect(loadIconNames({ cacheDir, fetch: f })).resolves.toEqual([]);
  });

  it("does not cache a refusal", async () => {
    // Writing a 404 body to the cache would poison the picker for a week.
    const cacheDir = await tempDir("hs-icons-");
    const f = vi.fn<typeof fetch>(
      async () => new Response("nope", { status: 404 }),
    );
    await expect(loadIconNames({ cacheDir, fetch: f })).resolves.toEqual([]);
    await expect(
      readFile(join(cacheDir, MANIFEST_FILE), "utf8"),
    ).rejects.toThrow();
  });
});
