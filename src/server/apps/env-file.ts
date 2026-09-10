export type EnvEntry =
  | { kind: "pair"; key: string; value: string; comment: string; raw: string }
  | { kind: "other"; raw: string };

/** Fixed width, so the mask reveals nothing about the secret's length. */
const MASK = "••••••••";

const PAIR = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

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

function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

/** Re-quotes on the way out only when the value would not survive unquoted. */
function quoteIfNeeded(value: string): string {
  return /[\s#'"]/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
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
 */
export function upsertEnv(entries: EnvEntry[], key: string, value: string): EnvEntry[] {
  const index = entries.findIndex((e) => e.kind === "pair" && e.key === key);
  if (index >= 0) {
    const existing = entries[index];
    const comment = existing?.kind === "pair" ? existing.comment : "";
    const next = [...entries];
    next[index] = {
      kind: "pair",
      key,
      value,
      comment,
      raw: `${key}=${quoteIfNeeded(value)}${comment}`,
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
