/**
 * Manual verification for the app catalog (`src/shared/catalog/catalog.json`) —
 * Task 1 of the app-catalog feature.
 *
 * There is no CI in this repo (see `scripts/check-schema-drift.ts`'s own header), and this
 * script hits the network and shells out to `docker` on every run — exactly the property a
 * test suite must not have, which is why `src/shared/catalog/index.test.ts` stops short
 * of these three checks and this script exists to run them by hand:
 *
 *     pnpm run verify:catalog
 *
 * For every entry, and for every service inside its `compose`:
 *
 *   1. `docker compose config` — the file is written to its own temp directory and the
 *      REAL `docker compose` binary is run against it (5.5.1 in this environment). This
 *      does not reimplement compose's own validation; it defers to it entirely.
 *   2. The image resolves in its registry — via `createRegistryClient` from
 *      `src/server/apps/registry.ts`, the SAME client the image-update checker uses. Not
 *      a second registry client: reused as-is, including its Docker Hub auth dance.
 *   3. `iconRef` exists in the dashboard-icons metadata — via `IconMetadata` from
 *      `src/server/icons/metadata.ts`, the same class the icon search endpoint uses.
 *
 * Also checks, across the whole catalog: no two entries share a slug, a name, or a
 * default published port. (Uniqueness needs no network and is ALSO asserted in
 * `index.test.ts` — repeated here so a single `verify:catalog` run is a complete
 * pre-flight, not one of two commands someone has to remember.)
 *
 * WHAT A GREEN RUN MEANS, AND DOES NOT MEAN: every entry's compose file resolves, and
 * every image and icon it names actually exists right now. It does NOT mean the entry is
 * a GOOD app definition. Whether the ports, volumes, and configuration are the right ones
 * for that application is a judgement this script cannot make and does not attempt —
 * that call is the author's, made once, when the entry is written. Green here reads as
 * "valid and resolvable", never as "good".
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryClient } from "@server/apps/registry.js";
import { IconMetadata } from "@server/icons/metadata.js";
import type { CatalogEntry } from "@shared/catalog/schema.js";
import { parse as parseYaml } from "yaml";

type ComposeDoc = { services?: Record<string, { image?: unknown; ports?: unknown[] }> };

type Failure = { slug: string; check: string; detail: string };

const failures: Failure[] = [];

function fail(slug: string, check: string, detail: string): void {
  failures.push({ slug, check, detail });
  console.log(`  FAIL [${check}] ${slug}: ${detail}`);
}

function pass(slug: string, check: string): void {
  console.log(`  ok   [${check}] ${slug}`);
}

/** Every image string named by any service in a compose document. */
function imagesIn(doc: ComposeDoc): string[] {
  return Object.values(doc.services ?? {})
    .map((service) => service.image)
    .filter((image): image is string => typeof image === "string" && image.length > 0);
}

/** The host-side port one `ports` entry publishes, with any `/tcp` or `/udp` suffix
 * stripped first — protocol never changes which host port is being claimed, so
 * `"6881:6881/tcp"` and `"6881:6881/udp"` must read as the same port, not two. Handles the
 * short string form (`"HOST:CONTAINER[/PROTOCOL]"`, optionally with a leading
 * `HOST_IP:`) and the long mapping form (`{ published, protocol }`). A bare
 * container-only port (no host mapping) publishes to a random host port each run and has
 * no fixed default to compare across entries, so it contributes nothing. Kept in sync
 * with the identical helper in `src/shared/catalog/index.test.ts`. */
function hostPortOf(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    const withoutProtocol = entry.split("/")[0] ?? entry;
    const segments = withoutProtocol.split(":");
    if (segments.length < 2) return undefined;
    return segments[segments.length - 2] || undefined;
  }
  if (typeof entry === "object" && entry !== null && "published" in entry) {
    const published = (entry as { published?: unknown }).published;
    return published === undefined || published === null || published === ""
      ? undefined
      : String(published);
  }
  return undefined;
}

/** The distinct host ports one compose document publishes, across every service. A
 * tcp/udp pair sharing a host port is one logical port, folded here so an entry can never
 * collide with itself over its own pair. An entry with none at all (`network_mode: host`)
 * is legitimate and contributes an empty set. */
function publishedPorts(doc: ComposeDoc): Set<string> {
  const ports = new Set<string>();
  for (const service of Object.values(doc.services ?? {})) {
    for (const entry of service.ports ?? []) {
      const host = hostPortOf(entry);
      if (host) ports.add(host);
    }
  }
  return ports;
}

/** Runs the real `docker compose config` against one entry's compose file, written to its
 * own temp directory so entries never share a working directory. */
async function verifyComposeConfig(entry: CatalogEntry): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `hs-verify-catalog-${entry.slug}-`));
  try {
    const composePath = join(dir, "compose.yaml");
    await writeFile(composePath, entry.compose, "utf8");
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn("docker", ["compose", "-f", composePath, "config"], {
        timeout: 30_000,
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => resolve({ code: 1, stderr: error.message }));
      child.on("close", (code) => resolve({ code, stderr }));
    });
    if (result.code === 0) {
      pass(entry.slug, "compose config");
    } else {
      fail(entry.slug, "compose config", result.stderr.trim() || `exit code ${result.code}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Confirms every image named by an entry's compose file resolves in its registry, reusing
 * the same client `ImageUpdateChecker` uses rather than a second implementation. */
async function verifyImages(entry: CatalogEntry, doc: ComposeDoc): Promise<void> {
  const images = imagesIn(doc);
  if (images.length === 0) {
    fail(entry.slug, "image", "compose file names no service with an image");
    return;
  }
  const registry = createRegistryClient({
    fetch,
    onError: (image, reason) => fail(entry.slug, "image", `${image}: ${reason}`),
  });
  for (const image of images) {
    const digest = await registry.latestDigest(image);
    if (digest) pass(entry.slug, `image ${image}`);
    // A failed lookup already called `onError` above, so nothing else to report here.
  }
}

/** Confirms `iconRef` exists in the dashboard-icons metadata index. */
async function verifyIcon(entry: CatalogEntry, metadata: IconMetadata): Promise<void> {
  if (metadata.has(entry.iconRef)) {
    pass(entry.slug, "icon");
  } else {
    fail(entry.slug, "icon", `iconRef "${entry.iconRef}" is not in dashboard-icons`);
  }
}

function verifyUniqueness(entries: readonly CatalogEntry[]): void {
  const bySlug = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const byPort = new Map<string, string[]>();

  for (const entry of entries) {
    const doc = parseYaml(entry.compose) as ComposeDoc;
    for (const port of publishedPorts(doc)) {
      byPort.set(port, [...(byPort.get(port) ?? []), entry.slug]);
    }
    bySlug.set(entry.slug, [...(bySlug.get(entry.slug) ?? []), entry.slug]);
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry.slug]);
  }

  for (const [slug, owners] of bySlug) {
    if (owners.length > 1) fail(owners.join(", "), "uniqueness", `slug "${slug}" is not unique`);
  }
  for (const [name, owners] of byName) {
    if (owners.length > 1) fail(owners.join(", "), "uniqueness", `name "${name}" is not unique`);
  }
  for (const [port, owners] of byPort) {
    if (owners.length > 1) {
      fail(
        owners.join(", "),
        "uniqueness",
        `published port "${port}" is used by more than one entry`,
      );
    }
  }
  if (failures.length === 0) console.log("  ok   [uniqueness] no shared slug, name, or port");
}

async function main(): Promise<void> {
  // Dynamic, not static: a schema-invalid catalog.json throws the moment anything
  // imports `@shared/catalog`, and a static import here would crash before this script
  // got to print anything. `src/shared/catalog/index.test.ts` is the right place for
  // that failure to surface — this script assumes it already passed and focuses on what
  // that test cannot check.
  const { CATALOG } = await import("../src/shared/catalog/index.js");

  console.log(
    `Verifying ${CATALOG.length} catalog ${CATALOG.length === 1 ? "entry" : "entries"}...\n`,
  );

  verifyUniqueness(CATALOG);

  // Own temp dir, removed in `finally` below — `IconMetadata` also writes a cache file
  // into it, so leaving this behind would litter /tmp on every run of this script.
  const iconCacheDir = await mkdtemp(join(tmpdir(), "hs-verify-catalog-icons-"));
  try {
    const iconMetadata = new IconMetadata({ cacheDir: iconCacheDir });
    await iconMetadata.load();
    if (iconMetadata.size === 0) {
      console.log(
        "\nwarning: dashboard-icons metadata loaded with zero entries — check network " +
          "access before trusting any icon FAIL below.",
      );
    }

    for (const entry of CATALOG) {
      console.log(`\n${entry.name} (${entry.slug})`);
      const doc = parseYaml(entry.compose) as ComposeDoc;
      await verifyComposeConfig(entry);
      await verifyImages(entry, doc);
      await verifyIcon(entry, iconMetadata);
    }
  } finally {
    await rm(iconCacheDir, { recursive: true, force: true });
  }

  console.log("");
  if (failures.length > 0) {
    console.log(`${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`  - ${f.slug} [${f.check}]: ${f.detail}`);
    console.log(
      "\nRemember: a green run above only means these entries are valid and resolvable, " +
        "not that they are good app definitions — see this script's header comment.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    "All entries are valid and resolvable. This is not a judgement on whether their " +
      "ports, volumes, or configuration are RIGHT for the application — see this script's " +
      "header comment.",
  );
}

await main();
