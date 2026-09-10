export type EnvEntry =
  | { kind: "pair"; key: string; value: string; comment: string; raw: string }
  | { kind: "other"; raw: string };

/** Fixed width, so the mask reveals nothing about the secret's length. */
const MASK = "••••••••";

// `\r?$` tolerates a file last edited on Windows. Without it the whole right-hand
// side keeps a trailing CR, the value is wrong, and — worse — every line reads as
// `other`, so a CRLF `.env` appears to contain no variables at all.
const PAIR = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*?)\r?$/;

/**
 * Escape sequences compose expands inside double quotes. An unrecognised sequence is
 * left verbatim, so a Windows path like `"C:\dir"` keeps its backslash.
 */
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' };

function unescapeDouble(value: string): string {
  return value.replace(/\\(.)/g, (whole, ch: string) => ESCAPES[ch] ?? whole);
}

/**
 * Splits a `.env` right-hand side into its value and its trailing comment.
 *
 * Follows compose's rules rather than inventing simpler ones:
 *  - a `#` starts a comment only when whitespace precedes it, so `PASS=hunter#2`
 *    keeps the `#` in the value
 *  - a `#` inside quotes is literal
 *  - one layer of matching surrounding quotes is removed from the value
 *
 * The comment is returned with its leading whitespace intact so `upsertEnv` can
 * reattach it exactly as the user wrote it.
 */
function splitValue(rest: string): { value: string; comment: string } {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      // A backslash escapes the next character inside double quotes only. Without
      // this, `A="has \" quote" # note` closes the quote at the escaped `"`, reopens
      // at the closing one, and never finds the comment — the whole line lands in the
      // value. Single quotes are literal, so a backslash there escapes nothing.
      if (quote === '"' && ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // Whitespace before the '#' is what makes it a comment rather than a literal.
    if (ch === "#" && (i === 0 || /\s/.test(rest[i - 1] ?? ""))) {
      // Find the start of the whitespace sequence before '#'
      let commentStart = i;
      while (commentStart > 0 && /\s/.test(rest[commentStart - 1] ?? "")) {
        commentStart--;
      }
      return {
        value: unquote(rest.slice(0, commentStart).trim()),
        comment: rest.slice(commentStart),
      };
    }
  }
  return { value: unquote(rest.trim()), comment: "" };
}

/**
 * Removes one layer of matching surrounding quotes.
 *
 * Compose is asymmetric here and so is this: a double-quoted value has its escape
 * sequences expanded, a single-quoted value is literal. Unescaping both would corrupt
 * `PASS='hunter\2'` into `hunter2` — and these are passwords, so the corruption is
 * silent until an app fails to authenticate.
 */
function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && value.endsWith(first ?? "")) {
    if (first === '"') return unescapeDouble(value.slice(1, -1));
    if (first === "'") return value.slice(1, -1);
  }
  return value;
}

/**
 * Re-quotes on the way out only when the value would not survive unquoted.
 *
 * The escaping here and `unescapeDouble` are a matched pair: whatever this writes must
 * read back identically. Newlines and tabs become sequences rather than literals
 * because a literal one would split the line and silently restructure the file.
 */
function quoteIfNeeded(value: string): string {
  if (!/[\s#'"\\]/.test(value)) return value;
  const escaped = value
    .replace(/([\\"])/g, "\\$1")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Parses `.env` while retaining every original line in `raw`.
 *
 * Serialising reassembles from `raw`, so comments, blank lines, spacing and
 * commented-out assignments survive a round trip untouched. These files are
 * hand-maintained over SSH and their comments carry real information.
 */
export function parseEnv(content: string): EnvEntry[] {
  if (content === "") return [];
  // Splitting on '\n' keeps a trailing newline representable as a final empty line,
  // which is what makes byte-for-byte round-tripping work.
  return content.split("\n").map((line) => {
    const match = PAIR.exec(line);
    if (!match) return { kind: "other", raw: line };
    const [, key, rest] = match;
    if (key === undefined) return { kind: "other", raw: line };
    const { value, comment } = splitValue(rest ?? "");
    return { kind: "pair", key, value, comment, raw: line };
  });
}

export function serialiseEnv(entries: EnvEntry[]): string {
  return entries.map((e) => e.raw).join("\n");
}

export function maskEnv(entries: EnvEntry[]): Array<{ key: string; masked: string }> {
  return entries
    .filter((e): e is Extract<EnvEntry, { kind: "pair" }> => e.kind === "pair")
    .map((e) => ({ key: e.key, masked: e.value === "" ? "" : MASK }));
}

/**
 * Replaces a key's value in place, or appends it before any trailing blank line.
 *
 * The existing entry's inline comment is carried onto the rebuilt line. Dropping it
 * would make editing one variable destroy the note explaining why it is set — the
 * precise loss this module exists to prevent, and one the user would only notice
 * later, over SSH.
 *
 * When a key appears more than once, the LAST occurrence is the one rewritten, because
 * that is the one compose reads. Rewriting the first was measured to produce a silent
 * no-op: `A=1\nA=2` edited to `9` became `A=9\nA=2`, the UI showed success, and the
 * container still started with `2`.
 */
export function upsertEnv(entries: EnvEntry[], key: string, value: string): EnvEntry[] {
  const index = entries.findLastIndex((e) => e.kind === "pair" && e.key === key);
  if (index >= 0) {
    const existing = entries[index];
    const comment = existing?.kind === "pair" ? existing.comment : "";
    // Preserve the line's own ending so one edit does not convert a CRLF file's line
    // to LF and leave the file mixed.
    const eol = existing?.raw.endsWith("\r") ? "\r" : "";
    const next = [...entries];
    next[index] = {
      kind: "pair",
      key,
      value,
      comment,
      raw: `${key}=${quoteIfNeeded(value)}${comment}${eol}`,
    };
    return next;
  }

  const trailingBlank = entries.length > 0 && entries[entries.length - 1]?.raw === "";
  const newEntry: EnvEntry = {
    kind: "pair",
    key,
    value,
    comment: "",
    raw: `${key}=${quoteIfNeeded(value)}`,
  };
  return trailingBlank
    ? [...entries.slice(0, -1), newEntry, { kind: "other", raw: "" }]
    : [...entries, newEntry];
}
