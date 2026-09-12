import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { enumsAt, isKnownPath, keysAt, type SchemaSuggestion } from "@shared/compose-schema";

/**
 * Value sets for keys whose real options the vendored schema does not encode as a JSON
 * Schema `enum` — Task 3's review measured the real 86 KB file and found exactly one
 * service property with a genuine `enum` (`cgroup`); `restart`, `pull_policy` and
 * `network_mode` describe their options in prose or a regex `pattern` only, so `enumsAt`
 * alone returns nothing for them. This table is hand-maintained against compose's
 * documented options, NOT derived from the schema, which is why every entry below carries
 * a `note` that says so: a future schema refresh that starts describing one of these
 * properly should read as "now redundant with the schema", not as "the schema always had
 * this". `restart` is the motivating entry — `unless-stopped` is the option people forget.
 *
 * Verified against the vendored schema's own prose (`src/shared/schema/compose-spec.json`),
 * which mirrors upstream compose-spec:
 * - `restart`'s description lists exactly `no`, `always`, `on-failure`, `unless-stopped` —
 *   the table below is complete for it, so its note stays the plain "hand-maintained" text.
 * - `pull_policy`'s `pattern` is
 *   `^(always|never|build|if_not_present|missing|refresh|daily|weekly|every_([0-9]+[wdhms])+)+$`,
 *   i.e. it also accepts `refresh`, `daily`, `weekly`, and a parameterised `every_<duration>`
 *   form the table can't enumerate — so, like `network_mode`, its note is worded as "common
 *   values" rather than "the values".
 * - `network_mode`'s description names `bridge`, `host`, `none`, `service:[service name]` and
 *   `container:[container name]`; the table lists the three plain modes and its note is
 *   worded the same way, rather than listing the two parameterised forms as literal,
 *   selectable entries a user would otherwise have to edit after inserting.
 */
const CURATED_VALUES: Readonly<Record<string, readonly string[]>> = {
  restart: ["no", "always", "on-failure", "unless-stopped"],
  pull_policy: ["always", "never", "missing", "if_not_present", "build"],
  network_mode: ["bridge", "host", "none"],
};

const CURATED_DOCS = "Hand-maintained value; not present in the vendored schema.";

const CURATED_DOCS_PARTIAL =
  "Hand-maintained value; not present in the vendored schema. These are common values, not the full set compose accepts.";

const CURATED_NOTES: Readonly<Record<string, string>> = {
  pull_policy: CURATED_DOCS_PARTIAL,
  network_mode: CURATED_DOCS_PARTIAL,
};

/**
 * The value suggestions for a key: the schema's own `enum` when it has one, otherwise this
 * file's curated table, otherwise nothing. The schema wins when both exist, per Task 3's
 * ruling — a real upstream enum is more trustworthy than our hand-maintained guess at the
 * same options.
 *
 * The curated table only ever supplements a path the schema already recognises — it must
 * never assert a key exists that the schema doesn't know about. `isKnownPath` gates on
 * exactly that: a trailing segment that matches a curated key (say, `restart`) but sits
 * under a path the schema doesn't describe (`deploy.restart`, where the real key is
 * `restart_policy`; or a line inside a `command: |` block scalar that happens to read
 * `restart: `, since a block scalar's body has no schema properties at all) gets nothing,
 * rather than the full curated list endorsing a key that isn't real there.
 *
 * That still isn't the whole gate: `services.<name>.depends_on.<name>.restart` is a real,
 * schema-known path, so `isKnownPath` alone lets it through — but there it's a boolean-ish
 * flag meaning "restart dependent services", not a restart policy, and offering
 * `unless-stopped` there would be a wrong list, not an absent one. `isServiceLevelPath`
 * keys the table on the path's *shape*, not just its trailing key: `restart` (and
 * `pull_policy`, `network_mode`) only apply at `services.<name>.<key>` itself. A schema
 * walk of all three curated keys confirmed this is the only such collision in the vendored
 * schema, so the shape check below can be exact rather than heuristic.
 */
function isServiceLevelPath(path: string[]): boolean {
  return path.length === 3 && path[0] === "services";
}

function valuesFor(schema: unknown, path: string[]): SchemaSuggestion[] {
  const fromSchema = enumsAt(schema, path);
  if (fromSchema.length > 0) return fromSchema;

  if (!isKnownPath(schema, path)) return [];

  const key = path[path.length - 1];
  const curated = key !== undefined && isServiceLevelPath(path) ? CURATED_VALUES[key] : undefined;
  if (!curated) return [];
  const docs = (key !== undefined && CURATED_NOTES[key]) || CURATED_DOCS;
  return curated.map((label) => ({ label, docs }));
}

/**
 * Exported alongside {@link pathAt} so document-completion.ts's declaredNames scan can
 * reuse the same indentation reading instead of re-deriving it.
 *
 * A tab counts as two columns of indentation, the same width as this codebase's own
 * compose examples use per level, rather than as zero. YAML forbids tabs for
 * indentation — the lint layer already reports that separately — so this is a rough
 * stand-in, not a claim about what the document's author intended. What it must not do
 * is read as column zero: a tab-indented child line sharing that value with a genuine
 * top-level line makes the section-end check below fire on the child, which throws
 * away every sibling that follows it too. Counting the tab as indentation (some
 * positive value) is enough to keep the scan going past it.
 */
export function indentOf(line: string): number {
  const TAB_WIDTH = 2;
  let count = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " ") count += 1;
    else if (ch === "\t") count += TAB_WIDTH;
    else break;
    i++;
  }
  return count;
}

/**
 * A key line's key, or `null` if the trimmed text isn't shaped like `key:` / `key: value`.
 * Exported for the same reason as {@link indentOf}.
 */
export function keyOf(trimmed: string): string | null {
  const match = /^([^:#]+):(\s|$)/.exec(trimmed);
  if (!match) return null;
  return (match[1] ?? "").trim();
}

/**
 * The path of ancestor keys enclosing the cursor's line, read from indentation alone —
 * never from a YAML parse. A document being edited is invalid YAML most of the time
 * somebody is mid-keystroke (a dangling `:`, an unclosed quote, a half-typed key), and a
 * parser that throws on that would withdraw completions at exactly the moment they're
 * wanted. The trade this accepts: a tab-indented document (this only counts leading spaces)
 * or a flow-style mapping (`{a: 1}`, which never contributes a path segment) will defeat
 * it. Both are considered acceptable for a completion helper, as opposed to the syntax
 * checker in yaml-lint.ts, which does use a real (non-throwing) parse.
 *
 * The walk goes backwards from the cursor's line, shrinking the indentation boundary each
 * time it finds a strictly-less-indented line, and collects that line's key. Blank and
 * comment-only lines are skipped without touching the boundary (they carry no indentation
 * information worth trusting). A sequence item (`- ...`) shrinks the boundary — so the walk
 * still climbs above it — but contributes no key of its own, since a list entry is not a
 * mapping key.
 */
export function pathAt(text: string, pos: number): string[] {
  const lines = text.split("\n");
  const currentIndex = text.slice(0, pos).split("\n").length - 1;
  const currentLine = lines[currentIndex] ?? "";
  let indent = indentOf(currentLine);

  const path: string[] = [];
  for (let i = currentIndex - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const lineIndent = indentOf(line);
    if (lineIndent >= indent) continue;
    indent = lineIndent;

    if (trimmed.startsWith("- ")) continue;

    const key = keyOf(trimmed);
    if (key !== null) path.unshift(key);
  }

  return path;
}

/**
 * Whether `beforeCursor` (the text of the current line up to the cursor) ends inside a
 * comment or an open quote — either way, nothing on this codebase's list of completions
 * belongs there. Quote tracking is a plain toggle, not a real YAML scalar parser: a `#`
 * inside a single-quoted string is correctly not a comment starter, but an escaped quote
 * inside a double-quoted string is not specially handled. That matches this file's other
 * documented trade-off (indentation over parsing) rather than fighting it.
 *
 * A `#` only starts a YAML comment when it is the first character on the line or preceded
 * by whitespace — mid-token, it's just a character. Treating every unquoted `#` as a
 * comment starter would blind completion inside a bare (unquoted) scalar that legitimately
 * contains one, such as a git build-context URL (`https://github.com/u/r.git#branch:dir`).
 *
 * Exported so `env-completion.ts` can reuse it: `${` interpolation is never expanded
 * inside a single-quoted YAML scalar (compose's own rule, not this codebase's), so a
 * `${` typed inside `'literal ${FOO}'` should get no popup either — the same class of
 * false trigger this already exists to prevent for schema completion.
 */
export function blockedByCommentOrQuote(beforeCursor: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < beforeCursor.length; i++) {
    const ch = beforeCursor[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      const prev = i === 0 ? undefined : beforeCursor[i - 1];
      if (prev === undefined || prev === " " || prev === "\t") return true;
    }
  }
  return inSingle || inDouble;
}

/**
 * The index of the last `:` in `text` that isn't inside a quoted string, or -1 if there is
 * none. Used to find the key/value separator on the cursor's line: the *nearest* colon
 * before the cursor, not the first one, so a quoted key that itself contains a colon
 * (`"traefik.http:rule": `) doesn't get mistaken for the separator, and typing that colon
 * mid-key (before the closing quote) doesn't flip completion into value mode.
 */
function lastUnquotedColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble) last = i;
  }
  return last;
}

function toCompletion(suggestion: SchemaSuggestion): {
  label: string;
  detail?: string;
  info?: string;
} {
  return { label: suggestion.label, detail: suggestion.detail, info: suggestion.docs };
}

/**
 * A stable factory: call it once per schema (the vendored one, in practice) and pass the
 * resulting `CompletionSource` straight into `YamlEditor`'s `extraExtensions`. `YamlEditor`
 * reconfigures that array's CodeMirror compartment by identity, not content — see its doc
 * comment — so a caller that instead wrote `extraExtensions={[schemaCompletion(schema)]}`
 * inline on every render would reconfigure the editor on every render. Building the
 * `CompletionSource` once here and letting the caller memoise the *array* it goes into
 * (`useMemo`, a module-level constant, etc.) is what keeps that cheap.
 *
 * Decides key-vs-value by whether the text before the cursor, on the cursor's own line,
 * contains an unquoted `:` (the last one, via {@link lastUnquotedColon}) — before it, the
 * cursor is naming a key and gets `keysAt`; after it, the cursor is writing a value and gets
 * that key's values via `valuesFor` (schema `enum` first, curated table otherwise).
 */
export function schemaCompletion(schema: unknown): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const beforeCursor = line.text.slice(0, context.pos - line.from);

    if (blockedByCommentOrQuote(beforeCursor)) return null;

    const word = context.matchBefore(/[\w.-]*/) ?? { from: context.pos, to: context.pos };
    const path = pathAt(context.state.doc.toString(), context.pos);

    const colonIndex = lastUnquotedColon(beforeCursor);
    const suggestions =
      colonIndex === -1
        ? keysAt(schema, path)
        : valuesFor(schema, [...path, beforeCursor.slice(0, colonIndex).trim()]);

    if (suggestions.length === 0) return null;

    return { from: word.from, options: suggestions.map(toCompletion) };
  };
}
