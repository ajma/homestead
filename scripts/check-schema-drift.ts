/**
 * Manual drift check for the vendored compose schema — Task 5 of Phase 1I.
 *
 * There is no CI in this repo (no `.github/workflows`, nothing), so nothing can run this
 * automatically. That's deliberate rather than a gap to fill here: Phase 1H's own
 * `scripts/verify-mount-preflight.sh` set the precedent that a manual gate which actually
 * runs beats an automated test that structurally cannot fail. Run this by hand,
 * periodically or before a release:
 *
 *     pnpm run check:schema-drift
 *
 * This is a script, not a test, and on purpose: it hits the network every run, which is
 * exactly the property a test suite must not have — a suite that fails when GitHub is slow
 * is a suite people learn to re-run rather than read. Nothing in `vitest run` calls this.
 *
 * Reuses `resolveCommitSha`/`fetchSchemaAt` from `compose-schema-source.ts` — the same
 * functions `vendor-compose-schema.ts` itself calls to produce the pin — so this can never
 * end up checking against a different URL than the one that actually vendors the schema.
 *
 * If this reports drift: report it, do not refresh it. Refreshing the pin changes what the
 * editor accepts as a valid compose.yaml key, which deserves its own review — see
 * `vendor-compose-schema.ts`'s own doc comment and `PINNED.md`.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchSchemaAt, resolveCommitSha } from "./compose-schema-source";

const PINNED_PATH = resolve("src/shared/schema/PINNED.md");
const LOCAL_SCHEMA_PATH = resolve("src/shared/schema/compose-spec.json");

/** Reads the commit line `vendor-compose-schema.ts` itself writes into `PINNED.md`. */
async function pinnedSha(): Promise<string> {
  const text = await readFile(PINNED_PATH, "utf8");
  const match = text.match(/^Commit:\s*([0-9a-f]{40})\s*$/m);
  if (!match?.[1]) throw new Error(`Could not find a pinned commit SHA in ${PINNED_PATH}`);
  return match[1];
}

/**
 * The keys a single service definition in compose.yaml is allowed to use —
 * `$defs.service.properties` in the schema's own vocabulary (`image`, `ports`,
 * `depends_on`, and so on). This, not the document's own top-level keys (`services`,
 * `networks`, `volumes`, ...), is what actually drives the editor's unknown-key warning
 * for an ordinary service block, and so is the part worth diffing: the document's
 * top-level shape changes far less often than the set of things one service can say.
 */
function serviceKeys(schema: unknown, sourceLabel: string): Set<string> {
  const defs = (schema as { $defs?: unknown })?.$defs as Record<string, unknown> | undefined;
  const service = defs?.service as { properties?: unknown } | undefined;
  const properties = service?.properties as Record<string, unknown> | undefined;
  if (!properties || typeof properties !== "object") {
    throw new Error(`${sourceLabel} does not have the expected $defs.service.properties shape`);
  }
  return new Set(Object.keys(properties));
}

async function main() {
  const pinned = await pinnedSha();
  const current = await resolveCommitSha("main");

  console.log(`Pinned commit:   ${pinned}`);
  console.log(`Upstream (main): ${current}`);

  if (pinned === current) {
    console.log("No drift: the vendored schema matches the tip of compose-spec's default branch.");
    return;
  }

  console.log("\nDRIFT: the vendored schema is behind compose-spec's default branch.");

  const [localSchema, upstreamSchema] = await Promise.all([
    readFile(LOCAL_SCHEMA_PATH, "utf8").then((text) => JSON.parse(text) as unknown),
    fetchSchemaAt(current),
  ]);

  const localKeys = serviceKeys(localSchema, "The vendored schema");
  const upstreamKeys = serviceKeys(upstreamSchema, "The upstream schema");
  const newKeys = [...upstreamKeys].filter((key) => !localKeys.has(key)).sort();

  if (newKeys.length === 0) {
    console.log(
      "\nNo new top-level service keys upstream. Likely a formatting, description, or " +
        "non-service change — read the actual upstream diff before deciding whether a " +
        "refresh is worth it.",
    );
  } else {
    console.log(`\nNew top-level service keys upstream: ${newKeys.join(", ")}`);
    console.log(
      "Until the pin is refreshed, any of these used in a real compose.yaml will draw an " +
        "unknown-key warning on an otherwise-correct file.",
    );
  }

  console.log(
    "\nDo not refresh the pin as a side effect of this check — see this script's own doc " +
      "comment. To refresh deliberately: pnpm exec tsx scripts/vendor-compose-schema.ts main",
  );

  process.exitCode = 1;
}

await main();
