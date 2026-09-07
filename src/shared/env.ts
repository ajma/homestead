/**
 * An ordered model of a `.env` file, per spec §4.2.
 *
 * Every line keeps its `raw` text. Editing one entry rewrites only that
 * entry's line; everything else — comments, blanks, and anything this parser
 * does not understand — is emitted byte-for-byte. Rebuilding the file from
 * key/value pairs would delete the annotations people rely on.
 */
export type EnvLine =
  | { kind: "comment"; raw: string }
  | { kind: "blank"; raw: string }
  | {
      kind: "entry";
      raw: string;
      key: string;
      value: string;
      exported: boolean;
      quote: "none" | "single" | "double";
      /**
       * Including a leading whitespace separator, e.g. `" # trailing"`.
       *
       * Normalised to always start with whitespace, even when the file wrote
       * it tight against a closing quote (`A="x"#note`): an untouched line is
       * re-emitted from `raw`, so normalisation only ever affects a line being
       * rewritten — and there `A=x#note` would mean the literal value
       * `x#note`, silently changing what compose reads.
       */
      inlineComment: string | null;
    }
  | { kind: "other"; raw: string };

const ENTRY = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Reads what follows a closing quote. `null` is "nothing there", a string is
 * an inline comment, and `undefined` means the line is not something compose
 * would accept, so the caller leaves it to `other`.
 *
 * Verified against Docker Compose v5.5.1. Unlike the unquoted case, *any*
 * `#` after a closing quote opens a comment — tight (`A="x"#note`), after a
 * tab, or after a space all yield `x`.
 *
 * Anything else is not a comment and not part of the value either: compose
 * keeps parsing the remainder as further assignments on the same line, so
 * `A="a" b=c` sets both `A=a` and `b=c` and exits 0, while
 * `A="tail" trailing junk` is a hard error ("key cannot contain a space").
 * Neither is one entry, so both are left to `other` and the raw editor. (An
 * earlier version of this comment claimed the trailing-text case always
 * errors. It does not — `A="a" b=c` is accepted. The routing was right for
 * the wrong reason.)
 */
function trailingComment(after: string): string | null | undefined {
  if (after.trim() === "") return null;
  const hash = after.indexOf("#");
  if (hash === -1 || after.slice(0, hash).trim() !== "") return undefined;
  const gap = after.slice(0, hash);
  return `${gap === "" ? " " : gap}${after.slice(hash)}`;
}

function parseValue(
  rest: string,
): Pick<
  Extract<EnvLine, { kind: "entry" }>,
  "value" | "quote" | "inlineComment"
> | null {
  if (rest.startsWith('"')) {
    // Find closing quote that's not escaped. Compose honours \" and \\ only.
    // Use parity: odd backslashes before a quote mean it's escaped, even means it closes.
    let end = -1;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '"') {
        // Count consecutive backslashes immediately before this quote
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && rest[j] === "\\"; j--) {
          backslashes++;
        }
        // Even backslashes (including 0) mean the quote closes the value
        if (backslashes % 2 === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return null; // unterminated — leave the line to `other`
    const comment = trailingComment(rest.slice(end + 1));
    if (comment === undefined) return null;
    // Unescape only \" → " and \\ → \, per compose's actual behaviour
    const escaped = rest.slice(1, end);
    const value = escaped.replace(/\\(["\\])/g, "$1");
    return { value, quote: "double", inlineComment: comment };
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    if (end === -1) return null;
    const comment = trailingComment(rest.slice(end + 1));
    if (comment === undefined) return null;
    return {
      value: rest.slice(1, end),
      quote: "single",
      inlineComment: comment,
    };
  }
  // Unquoted. Three rules, each taken from `docker compose config` on Compose
  // v5.5.1 rather than from the docs, and each easy to get wrong:
  //
  //   A=a#b        -> `a#b`      a `#` inside the value is literal
  //   A=#b         -> `#b`       so is one that *starts* the value
  //   A= # note    -> `# note`   a comment needs the value to have begun
  //   A=x #c       -> `x`        one space before the `#` opens a comment
  //   A=x\t#c      -> `x\t#c`    a *tab* before the `#` does not
  //   A=x \t#c     -> `x \t#c`   nor does a space that is not adjacent to it
  //   A=b   # note -> `b`        and the gap is trimmed off the value
  //
  // Hence ` #` and not `\s#`. The trailing gap moves into `inlineComment`
  // rather than being discarded, so re-rendering an unedited row reproduces
  // the original column alignment byte-for-byte.
  const lead = rest.length - rest.trimStart().length;
  const hash = rest.slice(lead).search(/ #/);
  if (hash === -1)
    return { value: rest.trim(), quote: "none", inlineComment: null };
  // `trimEnd` is load-bearing, not tidying: compose reads `A=b   # note` as
  // `b`, so keeping the spaces would make the form show `b  `, and saving that
  // untouched row would quote them into `A="b  " # note` — silently changing a
  // setting the user never edited.
  const value = rest.slice(lead, lead + hash).trimEnd();
  return {
    value,
    quote: "none",
    inlineComment: rest.slice(lead + value.length),
  };
}

export function parseEnv(text: string): EnvLine[] {
  return text.split("\n").map((raw): EnvLine => {
    if (raw.trim() === "") return { kind: "blank", raw };
    if (raw.trimStart().startsWith("#")) return { kind: "comment", raw };
    const m = ENTRY.exec(raw);
    if (!m) return { kind: "other", raw };
    const parsed = parseValue(m[3] as string);
    if (!parsed) return { kind: "other", raw };
    return {
      kind: "entry",
      raw,
      key: m[2] as string,
      exported: Boolean(m[1]),
      ...parsed,
    };
  });
}

export function serializeEnv(lines: EnvLine[]): string {
  return lines.map((l) => l.raw).join("\n");
}

/** Chooses the least surprising quoting that still round-trips to `value`. */
function renderEntry(
  line: Extract<EnvLine, { kind: "entry" }>,
  value: string,
): string {
  const prefix = `${line.exported ? "export " : ""}${line.key}=`;
  // Re-emitted on *every* branch, not just the unquoted one. Typing a space
  // into an annotated value flips the line to the quoted branch, and dropping
  // the comment there deletes an annotation §4.2 exists to protect — the
  // `# get this from the Immich admin panel` case, gone with no warning.
  const comment = line.inlineComment ?? "";
  // An *empty* value keeping a comment must be quoted: compose reads
  // `A= # note` as the literal value `# note`, so the unquoted form would turn
  // the annotation into the setting.
  const needsQuotes =
    /[\s#'"]/.test(value) ||
    value !== value.trim() ||
    (value === "" && comment !== "");
  if (line.quote === "single" && !value.includes("'"))
    return `${prefix}'${value}'${comment}`;
  if (needsQuotes || line.quote === "double")
    return `${prefix}"${value.replace(/(["\\])/g, "\\$1")}"${comment}`;
  return `${prefix}${value}${comment}`;
}

/**
 * Replaces the value of all entries with the given key. If a key appears
 * multiple times, all occurrences are updated; compose takes the last.
 */
export function setEntryValue(
  lines: EnvLine[],
  key: string,
  value: string,
): EnvLine[] {
  if (/[\n\r]/.test(value))
    throw new Error(
      "Value cannot contain newline; use the raw editor for multi-line values",
    );
  return lines.map((l) =>
    l.kind === "entry" && l.key === key
      ? { ...l, value, raw: renderEntry(l, value) }
      : l,
  );
}

export function addEntry(
  lines: EnvLine[],
  key: string,
  value: string,
): EnvLine[] {
  if (/[\n\r]/.test(value))
    throw new Error(
      "Value cannot contain newline; use the raw editor for multi-line values",
    );
  const line: Extract<EnvLine, { kind: "entry" }> = {
    kind: "entry",
    raw: "",
    key,
    value,
    exported: false,
    quote: "none",
    inlineComment: null,
  };
  const withRaw = { ...line, raw: renderEntry(line, value) };
  // A parsed file ends with a trailing blank produced by the final newline;
  // inserting before it keeps the file newline-terminated.
  const last = lines.at(-1);
  if (last?.kind === "blank" && last.raw === "")
    return [...lines.slice(0, -1), withRaw, last];
  return [...lines, withRaw];
}

/**
 * Removes all entries with the given key. If a key appears multiple times,
 * all occurrences are removed; compose takes the last.
 */
export function removeEntry(lines: EnvLine[], key: string): EnvLine[] {
  return lines.filter((l) => !(l.kind === "entry" && l.key === key));
}

const SECRET = /(PASSWORD|SECRET|TOKEN|_KEY|APIKEY|CREDENTIAL|PASSWD)/i;

/** Drives masking in the form. Advisory only — never a security boundary. */
export function isSecretKey(key: string): boolean {
  return SECRET.test(key);
}
