import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function resolveIcon(opts: {
  slug?: string | null;
  url?: string | null;
  cacheDir: string;
  fetch?: typeof fetch;
}): Promise<{ path: string } | null> {
  const fetchFn = opts.fetch ?? fetch;

  // Determine the URL and cache key
  let iconUrl: string;
  let cacheKey: string;

  if (opts.slug) {
    // Sanitize slug to prevent path traversal
    const sanitizedSlug = opts.slug.replace(/[^a-z0-9-]/g, "");
    if (sanitizedSlug.length === 0) {
      return null; // Invalid slug after sanitization
    }

    cacheKey = sanitizedSlug;
    iconUrl = `https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/${sanitizedSlug}.png`;
  } else if (opts.url) {
    // Validate protocol - only http: and https: allowed
    // We deliberately do NOT block private/loopback addresses (127.0.0.1, 192.168.x.x, etc.)
    // because:
    // 1. All icon URLs come from admins (manual apps are admin-only, compose files are admin-written)
    // 2. An admin already holds the Docker socket and is root-equivalent on this host
    // 3. Blocking private ranges would break legitimate home NAS use cases (e.g., http://192.168.1.50/icon.png)
    // If icon URLs ever become settable by non-admin viewers, this reasoning stops holding
    // and private ranges MUST be blocked to prevent SSRF.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(opts.url);
    } catch {
      return null; // Invalid URL
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null; // Only http and https allowed
    }

    iconUrl = opts.url;
    const hash = createHash("sha256").update(iconUrl).digest("hex");
    cacheKey = hash.substring(0, 16); // Use first 16 chars of hash
  } else {
    return null; // Neither slug nor url provided
  }

  // Ensure cache directory exists
  if (!existsSync(opts.cacheDir)) {
    mkdirSync(opts.cacheDir, { recursive: true });
  }

  // Check for cached icon (need to handle different extensions)
  // SVG is excluded - it can contain <script> tags and create XSS when served same-origin
  const possibleExtensions = ["png", "jpeg", "jpg", "webp"];
  for (const ext of possibleExtensions) {
    const cachedPath = join(opts.cacheDir, `${cacheKey}.${ext}`);
    if (existsSync(cachedPath)) {
      return { path: cachedPath };
    }
  }

  // Fetch the icon
  let response: Response;
  try {
    response = await fetchFn(iconUrl);
  } catch {
    return null; // Network error
  }

  if (!response.ok) {
    return null; // HTTP error
  }

  // Verify content type is an image (but reject SVG - XSS risk)
  const contentType = response.headers.get("content-type");
  if (!contentType?.startsWith("image/")) {
    return null; // Not an image
  }

  if (contentType === "image/svg+xml") {
    return null; // SVG rejected - can contain <script> tags
  }

  // Determine file extension from content type
  const extensionMap: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/jpg": "jpg",
    "image/webp": "webp",
  };

  const extension = extensionMap[contentType];
  if (!extension) {
    return null; // Unrecognized image type
  }

  // Download and verify magic bytes match content-type
  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch {
    return null; // Failed to read response
  }

  const bytes = new Uint8Array(buffer);

  // Verify magic bytes to prevent content-type mismatch attacks
  const isPng =
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  const isJpeg =
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const isWebp =
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;

  const magicBytesValid =
    (contentType === "image/png" && isPng) ||
    ((contentType === "image/jpeg" || contentType === "image/jpg") && isJpeg) ||
    (contentType === "image/webp" && isWebp);

  if (!magicBytesValid) {
    return null; // Content-type mismatch
  }

  const cachePath = join(opts.cacheDir, `${cacheKey}.${extension}`);

  try {
    writeFileSync(cachePath, Buffer.from(buffer));
  } catch {
    return null; // Failed to write cache
  }

  return { path: cachePath };
}
