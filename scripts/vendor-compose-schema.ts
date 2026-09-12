/**
 * Refreshes the vendored compose schema.
 *
 * Run by hand, never by the build: `pnpm exec tsx scripts/vendor-compose-schema.ts [ref]`.
 * The spec requires the schema be vendored at a pinned commit rather than fetched at
 * runtime, because the NAS may be offline and an upstream edit should not silently change
 * what the editor considers a valid key.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const REPO = "compose-spec/compose-spec";
const OUT = resolve("src/server/schema/compose-spec.json");

async function main() {
  const ref = process.argv[2] ?? "main";

  const commitResponse = await fetch(`https://api.github.com/repos/${REPO}/commits/${ref}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!commitResponse.ok) throw new Error(`Could not resolve ${ref}: ${commitResponse.status}`);
  const sha = (await commitResponse.json()).sha as string;
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Unexpected sha: ${sha}`);

  const raw = await fetch(
    `https://raw.githubusercontent.com/${REPO}/${sha}/schema/compose-spec.json`,
  );
  if (!raw.ok) throw new Error(`Could not download schema at ${sha}: ${raw.status}`);
  const text = await raw.text();

  // Parse before writing. A 404 page or a truncated download is still a 200 with a body,
  // and a corrupt schema would break completions everywhere with no obvious cause.
  const parsed = JSON.parse(text);
  if (typeof parsed?.properties?.services !== "object") {
    throw new Error("Downloaded file does not look like the compose schema");
  }

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
      `than silently emptying the editor's suggestions.\n`,
    "utf8",
  );
  console.log(`Vendored ${REPO}@${sha}`);
}

await main();
