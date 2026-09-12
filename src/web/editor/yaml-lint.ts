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

  walk(contents, [], schema, diagnostics, text.length);
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
