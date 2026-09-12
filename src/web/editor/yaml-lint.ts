import { isKnownPath } from "@shared/compose-schema";
import type { Pair, YAMLMap } from "yaml";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { EditorDiagnostic } from "./YamlEditor";

/**
 * Lint layer one: instant, positioned, and syntax/shape-only. It parses with `yaml` and walks
 * the schema, and nothing more — it has no network access and no opinion on whether
 * `depends_on` names a real service or `.env` defines a variable a service reads. Those are
 * semantic questions only `docker compose config` can answer, which is exactly why layer two
 * (a debounced round trip to that command) exists as a separate, unpositioned banner message
 * instead of being folded in here. Keeping the two apart is deliberate: merging them would
 * either make every keystroke wait on a subprocess, or make the subprocess's findings pretend
 * to be more precise than a full-document re-resolution can honestly claim to be.
 *
 * `parseDocument` (not `parse`) is the reason this can run on every keystroke at all: `parse`
 * throws on the first error, but a document being edited is invalid YAML most of the time
 * somebody is mid-keystroke, and `parseDocument` returns a document with an `errors` array
 * carrying offsets instead of throwing.
 */
export function lintYaml(text: string, schema: unknown): EditorDiagnostic[] {
  const doc = parseDocument(text, { prettyErrors: false });
  const diagnostics: EditorDiagnostic[] = [];

  for (const error of doc.errors) {
    diagnostics.push(fromRange(error.pos, "error", error.message, text.length));
  }
  for (const warning of doc.warnings) {
    diagnostics.push(fromRange(warning.pos, "warning", warning.message, text.length));
  }

  const { contents } = doc;
  // `null` covers both a truly empty document and one that is only whitespace/comments —
  // there is nothing to lint, and reporting an error about nothing would be worse than
  // reporting nothing.
  if (contents === null || contents === undefined) return diagnostics;

  if (!isMap(contents)) {
    const range = contents.range ?? [0, text.length, text.length];
    diagnostics.push(
      fromRange(
        range,
        "error",
        `A compose file must be a mapping of top-level keys, not ${shapeOf(contents)}.`,
        text.length,
      ),
    );
    return diagnostics;
  }

  // A syntax error means `yaml`'s error recovery has already reparented nodes to produce
  // *some* tree, but that tree does not reflect what the user actually typed — a single
  // tab-indentation mistake can knock keys out of their intended nesting and make them look
  // unknown at the level they land on. The syntax error above is already the actionable
  // message; walking a structure we know is a guess would only add warnings on code the user
  // never touched. Do not restore this walk under an error condition thinking it adds
  // coverage — it would be reading a document that doesn't exist.
  if (doc.errors.length === 0) {
    walk(contents, [], schema, diagnostics, text.length);
  }
  return diagnostics;
}

function shapeOf(node: unknown): string {
  if (isSeq(node)) return "a list";
  if (isScalar(node)) return "a plain value";
  return "this";
}

/**
 * Walks only the mapping structure of the document — compose is, at every level that matters
 * here, maps of maps. A key is checked against the schema at its full path; when the schema
 * doesn't know it, that's the unknown-key warning and there is nothing underneath it worth
 * describing a shape for, so the walk stops there rather than guessing. When the schema does
 * know it, and the value is itself a mapping, the walk continues one level deeper with the
 * extended path. Service, volume and network names are matched by the schema's
 * `patternProperties` (Task 3), so an arbitrary service name resolves as known without any
 * special-casing here — only a genuine typo in a fixed key, like `imag` instead of `image`,
 * is unknown.
 */
function walk(
  map: YAMLMap,
  path: readonly string[],
  schema: unknown,
  diagnostics: EditorDiagnostic[],
  maxLength: number,
): void {
  for (const pair of map.items as Pair[]) {
    const key = pair.key;
    if (!isScalar(key) || typeof key.value !== "string") continue;

    // `x-` extension keys are compose's escape hatch for user-defined content (anchors for
    // shared config are the idiomatic use — `x-defaults: &defaults`). The schema resolves the
    // extension key itself to a permissive `{}` node, but that node describes nothing about
    // what's inside it, so continuing to walk its children against the *root* schema would
    // check user-defined data against the wrong schema entirely and false-warn on every
    // nested key. Once a path enters an extension, everything beneath it is unknowable by
    // definition — stop here and report nothing for the subtree.
    if (key.value.startsWith("x-")) continue;

    // `<<` is YAML's merge key. `parseDocument` is used with the YAML 1.2 core schema
    // (merge keys off), which is deliberate: turning merge on would splice the anchor's pairs
    // into this map before the walk ever sees it, changing what "one key, one warning" means
    // everywhere else in this function for no benefit here. Treating the literal `<<` key as
    // never-reported is the smaller, more local fix — the schema was never going to know a
    // YAML syntax feature by name, and the aliased content it points at (`&defaults`) is
    // itself a normal mapping that gets its own schema-shaped warnings wherever it's written.
    if (key.value === "<<") continue;

    const keyPath = [...path, key.value];

    if (!isKnownPath(schema, keyPath)) {
      if (key.range) {
        diagnostics.push(fromRange(key.range, "warning", `Unknown key "${key.value}".`, maxLength));
      }
      continue;
    }

    if (isMap(pair.value)) walk(pair.value, keyPath, schema, diagnostics, maxLength);
  }
}

/**
 * Both `yaml`'s error `pos` ([start, end]) and its node `range` ([start, value-end, node-end])
 * are character offsets into the source; either's first two elements are the span this layer
 * reports. A syntax error near end-of-input can carry an end offset one past the text's
 * length (observed for an unterminated flow mapping), which CodeMirror's diagnostic API
 * rejects, so both ends are clamped to the document's length when one is supplied.
 */
function fromRange(
  range: readonly [number, number] | readonly [number, number, number],
  severity: EditorDiagnostic["severity"],
  message: string,
  maxLength: number,
): EditorDiagnostic {
  const clamp = (value: number) => Math.min(Math.max(value, 0), maxLength);
  const from = clamp(range[0]);
  const to = Math.max(clamp(range[1]), from);
  return { from, to, severity, message };
}
