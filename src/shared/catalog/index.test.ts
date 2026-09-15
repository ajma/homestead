/**
 * Everything about the catalog that can be checked with no network call — the schema,
 * cross-entry uniqueness, the *arr exclusion, and description shape. What this file
 * deliberately does NOT check: whether an image tag exists, whether an icon slug exists
 * in dashboard-icons, or whether `docker compose config` accepts the file. Those three
 * need a network round trip and/or the real `docker` binary, and belong to
 * `scripts/verify-catalog.ts`, run by hand — see that script's own header. A green run
 * of this test file means "well-formed", not "resolvable".
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathEscapeError, PathGuard } from "@server/host/paths";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CATALOG, catalogEntrySchema, catalogSchema } from "./index.js";

/**
 * Apps this catalog must never seed: starting one pulls in a media-management stack
 * nobody asked for, and the task brief excludes the whole group by name. Listed
 * explicitly, not matched by a "contains arr" pattern (which would also reject e.g.
 * "sonarr-adjacent" false positives and, more to the point, is not what was asked for) —
 * a later addition has to be checked against this exact list, and extending the list is a
 * reviewable, visible edit.
 */
const ARR_EXCLUSION_LIST = [
  "sonarr",
  "radarr",
  "lidarr",
  "readarr",
  "prowlarr",
  "bazarr",
  "whisparr",
];

type ComposeDoc = { services?: Record<string, { ports?: unknown[] }> };

/**
 * The host-side port one `ports` entry publishes, with any `/tcp` or `/udp` suffix
 * stripped first — protocol never changes which host port is being claimed, so
 * `"6881:6881/tcp"` and `"6881:6881/udp"` must read as the same port, not two. Handles the
 * short string form (`"HOST:CONTAINER[/PROTOCOL]"`, optionally with a leading
 * `HOST_IP:`) and the long mapping form (`{ published, protocol }`). A bare
 * container-only port (no host mapping, e.g. `"6881"`) publishes to a random host port
 * each run and has no fixed default to compare across entries, so it contributes nothing.
 */
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

/**
 * The distinct host ports one entry's compose file publishes, across every service. A
 * tcp/udp pair sharing a host port (`"6881:6881/tcp"` + `"6881:6881/udp"`) is one logical
 * port, folded here so an entry can never collide with itself over its own pair. An entry
 * with none at all — `network_mode: host`, which publishes nothing — is legitimate and
 * contributes an empty set, not a failure.
 */
function publishedPorts(compose: string): Set<string> {
  const doc = parseYaml(compose) as ComposeDoc;
  const ports = new Set<string>();
  for (const service of Object.values(doc.services ?? {})) {
    for (const entry of service.ports ?? []) {
      const host = hostPortOf(entry);
      if (host) ports.add(host);
    }
  }
  return ports;
}

describe("catalog", () => {
  it("has at least the three Task 1 seed entries", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(3);
  });

  it("every entry parses against the zod schema", () => {
    expect(catalogSchema.safeParse(CATALOG).success).toBe(true);
  });

  it("a failure names the offending entry, not just 'the catalog'", () => {
    for (const entry of CATALOG) {
      const result = catalogEntrySchema.safeParse(entry);
      if (!result.success) {
        expect.fail(`entry "${entry.slug}" failed schema validation: ${result.error.message}`);
      }
    }
  });

  describe("the schema itself rejects bad shapes", () => {
    const seed = CATALOG[0];
    if (!seed) throw new Error("the catalog needs at least one entry for this test");

    it("a slug that is not kebab-case", () => {
      expect(catalogEntrySchema.safeParse({ ...seed, slug: "Not_Kebab" }).success).toBe(false);
    });

    it("a slug with a path separator", () => {
      expect(catalogEntrySchema.safeParse({ ...seed, slug: "a/b" }).success).toBe(false);
    });

    it("a compose string with no services key", () => {
      expect(
        catalogEntrySchema.safeParse({ ...seed, compose: "not-a-compose-file: true\n" }).success,
      ).toBe(false);
    });

    it("a compose string with an empty services map", () => {
      expect(catalogEntrySchema.safeParse({ ...seed, compose: "services: {}\n" }).success).toBe(
        false,
      );
    });

    it("a homepage that is not http(s)", () => {
      expect(
        catalogEntrySchema.safeParse({ ...seed, homepage: "javascript:alert(1)" }).success,
      ).toBe(false);
    });

    it("a category outside the controlled vocabulary", () => {
      expect(
        catalogEntrySchema.safeParse({ ...seed, categories: ["not-a-real-category"] }).success,
      ).toBe(false);
    });
  });

  describe("slugs", () => {
    it("are unique", () => {
      const slugs = CATALOG.map((e) => e.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it("are kebab-case", () => {
      for (const entry of CATALOG) {
        expect(entry.slug, entry.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    });

    it("resolve as a directory name under the real PathGuard app creation uses", async () => {
      const root = await mkdtemp(join(tmpdir(), "hs-catalog-slug-"));
      try {
        const guard = new PathGuard(root);
        await guard.init();
        for (const entry of CATALOG) {
          await expect(guard.resolveForWrite(entry.slug), entry.slug).resolves.toBeTruthy();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("a slug with a '/' is exactly the shape PathGuard rejects, not something this test invents", async () => {
      const root = await mkdtemp(join(tmpdir(), "hs-catalog-slug-"));
      try {
        const guard = new PathGuard(root);
        await guard.init();
        // Same bad value `apps-create-local.test.ts` uses for the same reason: a slug
        // that names two path segments must fail before it ever reaches disk.
        await expect(guard.resolveForWrite("a/b")).rejects.toBeInstanceOf(PathEscapeError);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("no two entries share a display name", () => {
    const names = CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("no two entries share a default published port", () => {
    const allPorts = CATALOG.flatMap((entry) => [...publishedPorts(entry.compose)]);
    expect(allPorts.length).toBeGreaterThan(0);
    expect(new Set(allPorts).size).toBe(allPorts.length);
  });

  describe("port parsing is protocol-aware and per-entry", () => {
    it("a tcp/udp pair on the same host port within one entry is not a self-collision", () => {
      const ports = publishedPorts(
        'services:\n  app:\n    image: x\n    ports:\n      - "6881:6881/tcp"\n      - "6881:6881/udp"\n',
      );
      expect([...ports]).toEqual(["6881"]);
    });

    it("two different entries claiming the same host port is still a genuine collision", () => {
      const allPorts = [
        ...publishedPorts('services:\n  a:\n    image: x\n    ports:\n      - "9999:80"\n'),
        ...publishedPorts('services:\n  b:\n    image: x\n    ports:\n      - "9999:81"\n'),
      ];
      expect(new Set(allPorts).size).not.toBe(allPorts.length);
    });

    it("network_mode: host with no ports contributes nothing, and is not an error", () => {
      const ports = publishedPorts("services:\n  app:\n    image: x\n    network_mode: host\n");
      expect(ports.size).toBe(0);
    });
  });

  it("every compose value parses as YAML with a non-empty services map", () => {
    for (const entry of CATALOG) {
      const doc = parseYaml(entry.compose) as ComposeDoc;
      expect(doc.services, entry.slug).toBeTruthy();
      expect(Object.keys(doc.services ?? {}).length, entry.slug).toBeGreaterThan(0);
    }
  });

  it("excludes every *arr app by name — a later addition cannot quietly reintroduce one", () => {
    for (const entry of CATALOG) {
      expect(ARR_EXCLUSION_LIST, entry.slug).not.toContain(entry.slug);
      expect(
        ARR_EXCLUSION_LIST.map((n) => n.toLowerCase()),
        entry.slug,
      ).not.toContain(entry.name.toLowerCase());
    }
  });

  // Pins the list itself, not just what it's checked against. Every assertion above is
  // `expect(list).not.toContain(x)`, which an emptied `ARR_EXCLUSION_LIST` satisfies
  // vacuously — proved by the whole-branch review's mutation, which left this file's other
  // 22 tests green. This fails the moment the list stops naming the seven apps it exists
  // to exclude.
  it("names the seven *arr apps it exists to exclude, so emptying the list cannot pass silently", () => {
    for (const name of [
      "sonarr",
      "radarr",
      "lidarr",
      "readarr",
      "prowlarr",
      "bazarr",
      "whisparr",
    ]) {
      expect(ARR_EXCLUSION_LIST).toContain(name);
    }
  });

  describe("descriptions", () => {
    it("are under the length rendered in a browsing list", () => {
      for (const entry of CATALOG) {
        expect(entry.description.length, entry.slug).toBeLessThanOrEqual(160);
      }
    });

    it("are one sentence — any terminal punctuation ends the string, none appears mid-way", () => {
      for (const entry of CATALOG) {
        const enders = entry.description.match(/[.!?]/g) ?? [];
        expect(enders.length, entry.slug).toBeLessThanOrEqual(1);
        if (enders.length === 1) {
          const lastChar = entry.description.trim().slice(-1);
          expect(/[.!?]/.test(lastChar), entry.slug).toBe(true);
        }
      }
    });
  });
});
