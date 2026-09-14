/**
 * Everything about the catalogue that can be checked with no network call — the schema,
 * cross-entry uniqueness, the *arr exclusion, and description shape. What this file
 * deliberately does NOT check: whether an image tag exists, whether an icon slug exists
 * in dashboard-icons, or whether `docker compose config` accepts the file. Those three
 * need a network round trip and/or the real `docker` binary, and belong to
 * `scripts/verify-catalogue.ts`, run by hand — see that script's own header. A green run
 * of this test file means "well-formed", not "resolvable".
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathEscapeError, PathGuard } from "@server/host/paths";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CATALOGUE, catalogueEntrySchema, catalogueSchema } from "./index.js";

/**
 * Apps this catalogue must never seed: starting one pulls in a media-management stack
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
 * Host-side ports a compose string publishes, across every service. Handles both the
 * short `"HOST:CONTAINER"` string form (what every seed entry uses today) and the long
 * mapping form (`{ published, target }`), so this does not quietly stop working the day
 * an entry uses the other syntax.
 */
function publishedPorts(compose: string): string[] {
  const doc = parseYaml(compose) as ComposeDoc;
  const ports: string[] = [];
  for (const service of Object.values(doc.services ?? {})) {
    for (const entry of service.ports ?? []) {
      if (typeof entry === "string") {
        const host = entry.split(":")[0];
        if (host) ports.push(host);
      } else if (typeof entry === "object" && entry !== null && "published" in entry) {
        const published = (entry as { published?: unknown }).published;
        if (published !== undefined && published !== null) ports.push(String(published));
      }
    }
  }
  return ports;
}

describe("catalogue", () => {
  it("has at least the three Task 1 seed entries", () => {
    expect(CATALOGUE.length).toBeGreaterThanOrEqual(3);
  });

  it("every entry parses against the zod schema", () => {
    expect(catalogueSchema.safeParse(CATALOGUE).success).toBe(true);
  });

  it("a failure names the offending entry, not just 'the catalogue'", () => {
    for (const entry of CATALOGUE) {
      const result = catalogueEntrySchema.safeParse(entry);
      if (!result.success) {
        expect.fail(`entry "${entry.slug}" failed schema validation: ${result.error.message}`);
      }
    }
  });

  describe("the schema itself rejects bad shapes", () => {
    const seed = CATALOGUE[0];
    if (!seed) throw new Error("the catalogue needs at least one entry for this test");

    it("a slug that is not kebab-case", () => {
      expect(catalogueEntrySchema.safeParse({ ...seed, slug: "Not_Kebab" }).success).toBe(false);
    });

    it("a slug with a path separator", () => {
      expect(catalogueEntrySchema.safeParse({ ...seed, slug: "a/b" }).success).toBe(false);
    });

    it("a compose string with no services key", () => {
      expect(
        catalogueEntrySchema.safeParse({ ...seed, compose: "not-a-compose-file: true\n" }).success,
      ).toBe(false);
    });

    it("a compose string with an empty services map", () => {
      expect(catalogueEntrySchema.safeParse({ ...seed, compose: "services: {}\n" }).success).toBe(
        false,
      );
    });

    it("a homepage that is not http(s)", () => {
      expect(
        catalogueEntrySchema.safeParse({ ...seed, homepage: "javascript:alert(1)" }).success,
      ).toBe(false);
    });

    it("a category outside the controlled vocabulary", () => {
      expect(
        catalogueEntrySchema.safeParse({ ...seed, categories: ["not-a-real-category"] }).success,
      ).toBe(false);
    });
  });

  describe("slugs", () => {
    it("are unique", () => {
      const slugs = CATALOGUE.map((e) => e.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it("are kebab-case", () => {
      for (const entry of CATALOGUE) {
        expect(entry.slug, entry.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    });

    it("resolve as a directory name under the real PathGuard app creation uses", async () => {
      const root = await mkdtemp(join(tmpdir(), "hs-catalogue-slug-"));
      try {
        const guard = new PathGuard(root);
        await guard.init();
        for (const entry of CATALOGUE) {
          await expect(guard.resolveForWrite(entry.slug), entry.slug).resolves.toBeTruthy();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("a slug with a '/' is exactly the shape PathGuard rejects, not something this test invents", async () => {
      const root = await mkdtemp(join(tmpdir(), "hs-catalogue-slug-"));
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
    const names = CATALOGUE.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("no two entries share a default published port", () => {
    const allPorts = CATALOGUE.flatMap((entry) => publishedPorts(entry.compose));
    expect(allPorts.length).toBeGreaterThan(0);
    expect(new Set(allPorts).size).toBe(allPorts.length);
  });

  it("every compose value parses as YAML with a non-empty services map", () => {
    for (const entry of CATALOGUE) {
      const doc = parseYaml(entry.compose) as ComposeDoc;
      expect(doc.services, entry.slug).toBeTruthy();
      expect(Object.keys(doc.services ?? {}).length, entry.slug).toBeGreaterThan(0);
    }
  });

  it("excludes every *arr app by name — a later addition cannot quietly reintroduce one", () => {
    for (const entry of CATALOGUE) {
      expect(ARR_EXCLUSION_LIST, entry.slug).not.toContain(entry.slug);
      expect(
        ARR_EXCLUSION_LIST.map((n) => n.toLowerCase()),
        entry.slug,
      ).not.toContain(entry.name.toLowerCase());
    }
  });

  describe("descriptions", () => {
    it("are under the length rendered in a browsing list", () => {
      for (const entry of CATALOGUE) {
        expect(entry.description.length, entry.slug).toBeLessThanOrEqual(160);
      }
    });

    it("are one sentence — any terminal punctuation ends the string, none appears mid-way", () => {
      for (const entry of CATALOGUE) {
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
