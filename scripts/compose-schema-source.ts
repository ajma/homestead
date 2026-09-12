/**
 * Where `vendor-compose-schema.ts` (refreshes the pin) and `check-schema-drift.ts` (checks
 * it for drift, without refreshing it) both go to resolve a ref to a commit SHA and fetch
 * the schema JSON at one. Pulled out so the two can never quietly diverge into hitting two
 * different URLs for what is supposed to be the exact same upstream file — the drift check
 * would then be checking against a schema the vendoring script doesn't actually vendor.
 */

export const REPO = "compose-spec/compose-spec";

/** Resolves `ref` (a branch, tag, or SHA) to the full 40-character commit SHA GitHub has it at. */
export async function resolveCommitSha(ref: string): Promise<string> {
  const commitResponse = await fetch(`https://api.github.com/repos/${REPO}/commits/${ref}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!commitResponse.ok) throw new Error(`Could not resolve ${ref}: ${commitResponse.status}`);
  const sha = (await commitResponse.json()).sha as string;
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Unexpected sha: ${sha}`);
  return sha;
}

/**
 * Downloads and parses the compose schema as it stood at `sha`. Parses before returning —
 * a 404 page or a truncated download is still a 200 with a body, and a corrupt schema
 * would break completions everywhere (or, here, a diff against garbage) with no obvious
 * cause.
 */
export async function fetchSchemaAt(sha: string): Promise<unknown> {
  const raw = await fetch(
    `https://raw.githubusercontent.com/${REPO}/${sha}/schema/compose-spec.json`,
  );
  if (!raw.ok) throw new Error(`Could not download schema at ${sha}: ${raw.status}`);
  const text = await raw.text();
  const parsed = JSON.parse(text);
  if (typeof parsed?.properties?.services !== "object") {
    throw new Error("Downloaded file does not look like the compose schema");
  }
  return parsed;
}
