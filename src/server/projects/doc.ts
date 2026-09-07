import { isMap, parseDocument } from "yaml";

/**
 * Provenance, per spec §3.7: an adopted project has no `x-homestead` block at
 * all, so the *absence* of this key is what marks a directory Homestead did
 * not create — and that is exactly the case likeliest to hold something the
 * user cares about, which is why deletion asks twice.
 *
 * Checks that the value is a mapping (object) — scalars, arrays, and null are
 * treated as absent, since overwriting a user's key would be worse than
 * missing the provenance signal.
 */
export function hasHomesteadBlock(content: string): boolean {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) return false;
  if (!doc.has("x-homestead")) return false;
  const value = doc.get("x-homestead");
  return isMap(value);
}

/**
 * Adds the provenance block while preserving comments and formatting.
 *
 * Editing the Document rather than reserialising is the whole point: a pasted
 * compose file carries the author's comments, and round-tripping through a
 * plain object would delete them.
 *
 * Unparseable content is returned unchanged. Spec §6.1 stores an invalid paste
 * as given — the detail page already surfaces `parseError`, and refusing it
 * would discard content the user has nowhere else to put.
 *
 * "Unparseable" includes content that parses *fine* into something that is not
 * a mapping: `yaml`'s `setIn` throws on a bare scalar or a sequence, and by the
 * time this runs `createProject` has already made the directory. A pasted URL
 * or log line would otherwise 500, strand an empty directory, and 409 on the
 * retry — so the throw is caught here rather than being allowed to escape a
 * function whose contract is "returns the content unchanged".
 *
 * If `x-homestead` exists with any value type (scalar, array, object, null),
 * the content is returned unchanged — overwriting a user's deliberate key is
 * worse than missing the provenance signal.
 *
 * Preserves CRLF line endings from Windows editors. Files with mixed line
 * endings normalize to CRLF — preserving exact inconsistency would need
 * per-line tracking, which is disproportionate. Trailing newlines are added
 * per POSIX convention (every editor in the chain does the same).
 */
export function injectHomesteadBlock(
  content: string,
  source: { kind: "blank" | "paste" },
): string {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) return content;
  if (doc.has("x-homestead")) return content;

  const hasCRLF = content.includes("\r\n");
  try {
    doc.setIn(["x-homestead"], doc.createNode({ schemaVersion: 1, source }));
  } catch {
    return content;
  }
  let result = doc.toString();

  if (hasCRLF) {
    result = result.replace(/\n/g, "\r\n");
  }

  return result;
}

/**
 * The blank scaffold from spec §6.1.
 *
 * The comment sits *above* an explicit empty map on purpose: per §9.3,
 * `services:` followed only by comments parses as null and `docker compose
 * config` rejects it with "services must be a mapping".
 */
export function blankScaffold(slug: string): string {
  return `name: ${slug}
x-homestead:
  schemaVersion: 1
  source: { kind: blank }

# Add services below, for example:
#   web:
#     image: nginx
#     ports: ["127.0.0.1:8080:80"]
services: {}
`;
}
