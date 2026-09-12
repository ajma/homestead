/**
 * Refreshes the vendored compose schema.
 *
 * Run by hand, never by the build: `pnpm exec tsx scripts/vendor-compose-schema.ts [ref]`.
 * The spec requires the schema be vendored at a pinned commit rather than fetched at
 * runtime, because the NAS may be offline and an upstream edit should not silently change
 * what the editor considers a valid key.
 *
 * See `check-schema-drift.ts` for the read-only counterpart to this: it reports when this
 * script's own output has fallen behind, without ever running this one automatically —
 * refreshing the pin changes editor behaviour and is a deliberate, reviewed action, not
 * something a drift check should do on a repo's behalf.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fetchSchemaAt, REPO, resolveCommitSha } from "./compose-schema-source";

const OUT = resolve("src/shared/schema/compose-spec.json");

async function main() {
  const ref = process.argv[2] ?? "main";

  const sha = await resolveCommitSha(ref);
  const parsed = await fetchSchemaAt(sha);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await writeFile(
    resolve(dirname(OUT), "PINNED.md"),
    `# Vendored compose schema\n\n` +
      `Source: https://github.com/${REPO}\n` +
      `Commit: ${sha}\n` +
      `Vendored: ${new Date().toISOString().slice(0, 10)}\n\n` +
      `Refresh with:\n\n    pnpm exec tsx scripts/vendor-compose-schema.ts <ref>\n\n` +
      `Then run the suite. \`compose-schema-vendored.test.ts\` checks the shape the\n` +
      `completion walk depends on, so a breaking upstream restructure fails there rather\n` +
      `than silently emptying the editor's suggestions.\n\n` +
      `## Checking for drift\n\n` +
      `There is no CI in this repo, so nothing checks this automatically — it's a manual\n` +
      `gate, same shape as \`scripts/verify-mount-preflight.sh\`. Run it by hand, periodically\n` +
      `or before a release:\n\n` +
      `    pnpm run check:schema-drift\n\n` +
      `It reports the pinned commit above, the current commit on compose-spec's default\n` +
      `branch, whether they differ, and — if they do — which top-level service keys\n` +
      `(\`$defs.service.properties\` in the schema's own terms — \`image\`, \`ports\`,\n` +
      `\`depends_on\`, and so on) are new upstream. That's the actionable part: a schema\n` +
      `commit that only touches formatting or descriptions isn't worth a refresh; one that\n` +
      `adds real service keys is.\n\n` +
      `If it reports drift, do not refresh the pin as part of resolving that check — see\n` +
      `this script's own doc comment. Refreshing changes what the editor accepts as a valid\n` +
      `key, which deserves its own review, not a side effect of running a check script.\n\n` +
      `If the pin is left to drift anyway, the failure is silent and in the worst possible\n` +
      `direction: a key compose adds upstream reads as unknown here and draws a warning on\n` +
      `an otherwise-correct compose.yaml. A gutter that cries wolf on correct files is one\n` +
      `people learn to stop reading.\n`,
    "utf8",
  );
  console.log(`Vendored ${REPO}@${sha}`);
}

await main();
