import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { indentOf, keyOf, pathAt } from "./schema-completion";

export type DeclaredNames = {
  services: string[];
  volumes: string[];
  networks: string[];
};

/**
 * The names declared directly under a top-level `sectionKey:` mapping — e.g. the
 * service names under `services:`, or the volume names under `volumes:`. Reads
 * `lines` once, so `declaredNames` below shares the split instead of each of its
 * three calls re-splitting the document.
 *
 * The child indentation level is learned from the first non-blank, non-comment line
 * after the section header rather than assumed to be some fixed number of spaces
 * (a document might use 2, 4, or something stranger). Once learned, only lines at
 * exactly that indentation contribute a name; anything deeper is a nested property
 * of that entry (an `image:` under a service, a `depends_on` list item) and anything
 * shallower — including another indent-0 line — means the section has ended.
 */
function topLevelChildren(lines: string[], sectionKey: string): string[] {
  const sectionIndex = lines.findIndex(
    (line) => indentOf(line) === 0 && keyOf(line.trim()) === sectionKey,
  );
  if (sectionIndex === -1) return [];

  const names: string[] = [];
  let childIndent: number | null = null;

  for (let i = sectionIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = indentOf(line);
    if (indent === 0) break;
    if (childIndent === null) childIndent = indent;
    if (indent < childIndent) break;
    if (indent > childIndent) continue;

    const key = keyOf(trimmed);
    if (key !== null) names.push(key);
  }

  return names;
}

/**
 * Service, volume and network names declared in the current document — read with the
 * same line-based scan `pathAt` uses in schema-completion.ts, never a YAML parse.
 * This runs from `documentCompletion` below on every keystroke, and the document is
 * invalid YAML far more often than it is valid while someone is mid-edit: a dangling
 * `:`, an unclosed list item, a key with no value yet. A parser that throws on that
 * would withdraw completions at exactly the moment they're wanted, so a broken
 * document here still yields whatever whole, well-formed entries it can find —
 * see the "half-typed document" test for the case this exists to cover.
 *
 * Exported for testing.
 */
export function declaredNames(text: string): DeclaredNames {
  const lines = text.split("\n");
  return {
    services: topLevelChildren(lines, "services"),
    volumes: topLevelChildren(lines, "volumes"),
    networks: topLevelChildren(lines, "networks"),
  };
}

const REFERENCE_KEYS = new Set(["depends_on", "volumes", "networks"]);

/**
 * A stable factory, shaped like schema-completion.ts's `schemaCompletion`: call it
 * once and pass the resulting `CompletionSource` into `YamlEditor`'s
 * `extraExtensions` array, which the caller (Task 10) must memoise — that array is
 * reconfigured by identity, not content. See `schemaCompletion`'s doc comment for
 * why.
 *
 * Covers the two document-local completion contexts from the spec's completion
 * table, both read from `pathAt`'s ancestor path rather than any parse:
 *
 *  - inside a service's `depends_on` list: the document's other service names,
 *    excluding the service the cursor is currently inside. Depending on yourself is
 *    never what someone meant, and today the only way to find that out is compose
 *    refusing to start — offering it here is how they'd find out later instead.
 *  - inside a service's `volumes` or `networks` list: the document's top-level
 *    declared volume or network names.
 *
 * Anywhere else this returns null; schema-completion.ts's schema-driven source
 * already covers keys and enum values.
 */
export function documentCompletion(): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const text = context.state.doc.toString();
    const path = pathAt(text, context.pos);
    if (path.length !== 3 || path[0] !== "services") return null;

    const currentService = path[1];
    const key = path[2];
    if (currentService === undefined || key === undefined || !REFERENCE_KEYS.has(key)) {
      return null;
    }

    const names = declaredNames(text);
    const candidates =
      key === "depends_on"
        ? names.services.filter((name) => name !== currentService)
        : key === "volumes"
          ? names.volumes
          : names.networks;

    if (candidates.length === 0) return null;

    const word = context.matchBefore(/[\w.-]*/) ?? { from: context.pos, to: context.pos };
    return { from: word.from, options: candidates.map((label) => ({ label })) };
  };
}
