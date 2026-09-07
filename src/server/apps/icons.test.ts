import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveIcon } from "./icons.js";

describe("resolveIcon", () => {
  it("serves a cached icon without fetching", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    let fetchCalled = false;

    const mockFetch = async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    };

    // Pre-populate cache
    const { writeFileSync } = await import("node:fs");
    const cachedPath = join(cacheDir, "jellyfin.png");
    writeFileSync(cachedPath, Buffer.from("fake-png-data"));

    const result = await resolveIcon({
      slug: "jellyfin",
      cacheDir,
      fetch: mockFetch as typeof fetch,
    });

    expect(fetchCalled).toBe(false);
    expect(result).toEqual({ path: cachedPath });

    rmSync(cacheDir, { recursive: true });
  });

  it("fetches and caches on first call, serves from cache on second", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    let fetchCount = 0;

    const mockFetch = async (_url: string) => {
      fetchCount++;
      // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      return {
        ok: true,
        headers: {
          get: (name: string) => (name === "content-type" ? "image/png" : null),
        },
        arrayBuffer: async () => pngBytes,
      } as unknown as Response;
    };

    // First call: should fetch
    const result1 = await resolveIcon({
      slug: "sonarr",
      cacheDir,
      fetch: mockFetch as typeof fetch,
    });
    expect(fetchCount).toBe(1);
    expect(result1).not.toBeNull();
    expect(result1?.path).toMatch(/sonarr\.png$/);
    if (result1) {
      expect(existsSync(result1.path)).toBe(true);
    }

    // Second call: should serve from cache
    const result2 = await resolveIcon({
      slug: "sonarr",
      cacheDir,
      fetch: mockFetch as typeof fetch,
    });
    expect(fetchCount).toBe(1); // Still 1, no second fetch
    expect(result2?.path).toBe(result1?.path);

    rmSync(cacheDir, { recursive: true });
  });

  it("returns null when fetch fails", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));

    const mockFetch = async () => {
      return {
        ok: false,
        status: 404,
      } as unknown as Response;
    };

    const result = await resolveIcon({
      slug: "nonexistent",
      cacheDir,
      fetch: mockFetch as typeof fetch,
    });

    expect(result).toBeNull();

    rmSync(cacheDir, { recursive: true });
  });

  it("returns null when content-type is not an image", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));

    const mockFetch = async () => {
      return {
        ok: true,
        headers: {
          get: (name: string) => (name === "content-type" ? "text/html" : null),
        },
        arrayBuffer: async () => Buffer.from("<html>error</html>"),
      } as unknown as Response;
    };

    const result = await resolveIcon({
      slug: "bad-response",
      cacheDir,
      fetch: mockFetch as typeof fetch,
    });

    expect(result).toBeNull();

    rmSync(cacheDir, { recursive: true });
  });

  it("prevents path traversal attacks", async () => {
    // Create a temp directory structure with a cache subdir
    const testRoot = mkdtempSync(join(tmpdir(), "icons-test-"));
    const cacheDir = join(testRoot, "cache");
    const targetDir = join(testRoot, "target");

    const { mkdirSync } = await import("node:fs");
    mkdirSync(cacheDir);
    mkdirSync(targetDir);

    const mockFetch = async () => {
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      return {
        ok: true,
        headers: {
          get: (name: string) => (name === "content-type" ? "image/png" : null),
        },
        arrayBuffer: async () => pngBytes,
      } as unknown as Response;
    };

    // Attempt path traversal to escape cache/ into target/
    const result = await resolveIcon({
      slug: "../target/escaped",
      cacheDir,
      fetch: mockFetch as typeof fetch,
    });

    // If a file was written, it must be inside cacheDir
    if (result !== null) {
      expect(
        result.path.startsWith(`${cacheDir}/`),
        `Path traversal: ${result.path} escapes ${cacheDir}`,
      ).toBe(true);

      // Verify the file exists in cacheDir
      expect(existsSync(result.path)).toBe(true);
    }

    // Verify no file was written to the target directory
    const { readdirSync } = await import("node:fs");
    const targetFiles = readdirSync(targetDir);
    expect(
      targetFiles.length,
      `Path traversal successful: files written to ${targetDir}: ${targetFiles.join(", ")}`,
    ).toBe(0);

    rmSync(testRoot, { recursive: true });
  });

  it("resolves icons by URL when provided", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    let fetchedUrl = "";

    const mockFetch = async (url: string) => {
      fetchedUrl = url;
      // WebP magic bytes: RIFF....WEBP
      const webpBytes = Buffer.from([
        0x52,
        0x49,
        0x46,
        0x46, // RIFF
        0x00,
        0x00,
        0x00,
        0x00, // file size (placeholder)
        0x57,
        0x45,
        0x42,
        0x50, // WEBP
      ]);
      return {
        ok: true,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "image/webp" : null,
        },
        arrayBuffer: async () => webpBytes,
      } as unknown as Response;
    };

    const result = await resolveIcon({
      url: "https://example.com/custom-icon.webp",
      cacheDir,
      fetch: mockFetch as typeof fetch,
    });

    expect(fetchedUrl).toBe("https://example.com/custom-icon.webp");
    expect(result).not.toBeNull();
    expect(result?.path).toMatch(/\.webp$/);
    if (result) {
      expect(existsSync(result.path)).toBe(true);
    }

    rmSync(cacheDir, { recursive: true });
  });

  it("returns null when neither slug nor url is provided", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));

    const result = await resolveIcon({
      cacheDir,
    });

    expect(result).toBeNull();

    rmSync(cacheDir, { recursive: true });
  });

  it("supports different image extensions based on content-type", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));

    const mockFetchJpeg = async () => {
      // JPEG magic bytes: FF D8 FF
      const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      return {
        ok: true,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "image/jpeg" : null,
        },
        arrayBuffer: async () => jpegBytes,
      } as unknown as Response;
    };

    const result = await resolveIcon({
      slug: "photo-app",
      cacheDir,
      fetch: mockFetchJpeg as typeof fetch,
    });

    expect(result).not.toBeNull();
    expect(result?.path).toMatch(/\.jpeg$/);

    rmSync(cacheDir, { recursive: true });
  });

  it("rejects SVG to prevent XSS", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));

    const mockFetch = async () => {
      return {
        ok: true,
        headers: {
          get: (name: string) =>
            name === "content-type" ? "image/svg+xml" : null,
        },
        arrayBuffer: async () =>
          Buffer.from("<svg><script>alert(1)</script></svg>"),
      } as unknown as Response;
    };

    const result = await resolveIcon({
      slug: "malicious",
      cacheDir,
      fetch: mockFetch as typeof fetch,
    });

    expect(result).toBeNull();

    rmSync(cacheDir, { recursive: true });
  });

  it("rejects content-type mismatch (HTML claiming to be PNG)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));

    const mockFetch = async () => {
      return {
        ok: true,
        headers: {
          get: (name: string) => (name === "content-type" ? "image/png" : null),
        },
        arrayBuffer: async () => Buffer.from("<html>error page</html>"),
      } as unknown as Response;
    };

    const result = await resolveIcon({
      slug: "fake-png",
      cacheDir,
      fetch: mockFetch as typeof fetch,
    });

    expect(result).toBeNull();

    rmSync(cacheDir, { recursive: true });
  });

  it("rejects file: protocol", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    let fetchCalled = false;

    const mockFetch = async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    };

    const result = await resolveIcon({
      url: "file:///etc/passwd",
      cacheDir,
      fetch: mockFetch as typeof fetch,
    });

    expect(result).toBeNull();
    expect(fetchCalled).toBe(false);

    rmSync(cacheDir, { recursive: true });
  });

  it("rejects ftp: protocol", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "icons-"));
    let fetchCalled = false;

    const mockFetch = async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    };

    const result = await resolveIcon({
      url: "ftp://example.com/icon.png",
      cacheDir,
      fetch: mockFetch as typeof fetch,
    });

    expect(result).toBeNull();
    expect(fetchCalled).toBe(false);

    rmSync(cacheDir, { recursive: true });
  });
});
