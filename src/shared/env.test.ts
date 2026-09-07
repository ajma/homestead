import { describe, expect, it } from "vitest";
import {
  addEntry,
  isSecretKey,
  parseEnv,
  removeEntry,
  serializeEnv,
  setEntryValue,
} from "./env.js";

const SAMPLE = `# Immich
# get this from the admin panel
API_KEY="s3cr3t value"
export EXPORTED=yes
INLINE=value # trailing
SINGLE='$NOTEXPANDED'
EMPTY=

PLAIN=hello
`;

describe("parseEnv / serializeEnv", () => {
  it("round-trips a file byte-identically when nothing is edited", () => {
    expect(serializeEnv(parseEnv(SAMPLE))).toBe(SAMPLE);
  });

  it("round-trips content the parser does not model", () => {
    const weird = 'MULTI="line one\nline two"\n}}garbage{{\n';
    expect(serializeEnv(parseEnv(weird))).toBe(weird);
  });

  it("reads the value each compose quoting form actually yields", () => {
    const byKey = Object.fromEntries(
      parseEnv(SAMPLE).flatMap((l) => (l.kind === "entry" ? [[l.key, l]] : [])),
    );
    expect(byKey.API_KEY?.value).toBe("s3cr3t value");
    expect(byKey.EXPORTED?.value).toBe("yes");
    expect(byKey.EXPORTED?.exported).toBe(true);
    expect(byKey.INLINE?.value).toBe("value");
    expect(byKey.INLINE?.inlineComment).toBe(" # trailing");
    expect(byKey.SINGLE?.value).toBe("$NOTEXPANDED");
    expect(byKey.EMPTY?.value).toBe("");
  });

  it("preserves an inline comment when only the value changes", () => {
    const out = serializeEnv(
      setEntryValue(parseEnv(SAMPLE), "INLINE", "changed"),
    );
    expect(out).toContain("INLINE=changed # trailing");
  });

  /**
   * The regression the old suite could not see: it asserted `inlineComment`
   * was *parsed*, never that it *survived* an edit. Every value here forces a
   * different render branch, and typing a single space is enough to reach the
   * quoted one from the ordinary form.
   */
  it("keeps an inline comment whatever quoting the new value forces", () => {
    const cases = [
      { key: "A", from: "A=b # note\n", to: "c d", want: 'A="c d" # note\n' },
      { key: "A", from: "A=b # note\n", to: "plain", want: "A=plain # note\n" },
      // Not `A= # note`: compose would read that as the literal `# note`.
      { key: "A", from: "A=b # note\n", to: "", want: 'A="" # note\n' },
      {
        key: "A",
        from: "A=b # note\n",
        to: 'has"quote',
        want: 'A="has\\"quote" # note\n',
      },
      {
        key: "E",
        from: "export E=1 # keep me\n",
        to: "2 3",
        want: 'export E="2 3" # keep me\n',
      },
      { key: "A", from: "A='x' # note\n", to: "y z", want: "A='y z' # note\n" },
      { key: "A", from: 'A="x" # note\n', to: "y", want: 'A="y" # note\n' },
      // Written tight against the closing quote; compose still reads it as a
      // comment, and re-emitting it tight would fold it into the value.
      { key: "A", from: 'A="x"#note\n', to: "y z", want: 'A="y z" #note\n' },
    ];
    for (const { key, from, to, want } of cases) {
      expect(serializeEnv(setEntryValue(parseEnv(from), key, to)), from).toBe(
        want,
      );
    }
  });

  it("reads a comment after a closing quote, and refuses anything else there", () => {
    // Compose v5.5.1: `A="c d" # note` is `c d`. Trailing text that is not a
    // comment is *not* a parse error, which an earlier version of this comment
    // wrongly claimed — `A="a" b=c` sets both `A=a` and `b=c` and exits 0,
    // while only `A="tail" trailing junk` fails ("key cannot contain a
    // space"). Neither is one entry, so both belong in `other` regardless.
    const quoted = parseEnv('A="c d" # note\n')[0];
    expect(quoted).toMatchObject({
      kind: "entry",
      value: "c d",
      quote: "double",
      inlineComment: " # note",
    });
    const single = parseEnv("A='s q' # note\n")[0];
    expect(single).toMatchObject({
      kind: "entry",
      value: "s q",
      inlineComment: " # note",
    });
    expect(parseEnv('A="x"#tight\n')[0]).toMatchObject({
      inlineComment: " #tight",
    });
    expect(parseEnv('A="x"\t#tab\n')[0]).toMatchObject({
      value: "x",
      inlineComment: "\t#tab",
    });
    for (const line of ['A="tail" junk\n', 'A="a" b=c\n']) {
      expect(parseEnv(line)[0]?.kind, line).toBe("other");
      expect(serializeEnv(parseEnv(line)), line).toBe(line);
    }
  });

  /**
   * Column-aligned comments are ordinary `.env` style, and the gap before the
   * `#` is not part of the value — compose reads `A=b   # note` as `b`.
   *
   * The second half is the one that matters and the one whose absence let a
   * regression through: re-rendering a row the user *did not edit* must
   * reproduce the line byte-for-byte. Keeping the spaces in the value made
   * them trip `needsQuotes`, so merely saving the file rewrote the row as
   * `A="b  " # note` — which compose then really does read as `b  `. Saving
   * changed a setting nobody touched.
   */
  it("does not absorb the gap before a column-aligned comment into the value", () => {
    const cases = [
      { line: "A=b   # note", value: "b" },
      { line: "A=b\t # note", value: "b" },
      { line: "PUID=1000    # from id -u", value: "1000" },
    ];
    for (const { line, value } of cases) {
      const parsed = parseEnv(`${line}\n`)[0];
      expect(parsed, line).toMatchObject({ kind: "entry", value });
      // Re-render the row with the value it already has: this is what saving
      // an untouched form does, and it must be a no-op on the bytes.
      const key = line.slice(0, line.indexOf("="));
      expect(
        serializeEnv(setEntryValue(parseEnv(`${line}\n`), key, value)),
        line,
      ).toBe(`${line}\n`);
    }
  });

  it("reads an unquoted `#` the way compose does, not the way it looks", () => {
    // Every expectation here was taken from `docker compose config` on
    // Compose v5.5.1, not from reading the docs. A `#` only opens a comment
    // once the value has begun, and only when a *space* sits immediately
    // before it — a tab does not (`A=x\t#c` is the literal `x\t#c`).
    const value = (text: string) => {
      const line = parseEnv(text)[0];
      return line?.kind === "entry"
        ? { value: line.value, inlineComment: line.inlineComment }
        : { value: null, inlineComment: null };
    };
    expect(value("A=a#b\n")).toEqual({ value: "a#b", inlineComment: null });
    expect(value("A=#b\n")).toEqual({ value: "#b", inlineComment: null });
    expect(value("A= # note\n")).toEqual({
      value: "# note",
      inlineComment: null,
    });
    expect(value("A=x\t#tab\n")).toEqual({
      value: "x\t#tab",
      inlineComment: null,
    });
    expect(value("A=x \t#sp_tab\n")).toEqual({
      value: "x \t#sp_tab",
      inlineComment: null,
    });
    expect(value("A= x # note\n")).toEqual({
      value: "x",
      inlineComment: " # note",
    });
  });

  it("keeps every untouched line when one value is edited", () => {
    const out = serializeEnv(
      setEntryValue(parseEnv(SAMPLE), "PLAIN", "goodbye"),
    );
    expect(out).toContain("# get this from the admin panel");
    expect(out).toContain(`SINGLE='$NOTEXPANDED'`);
    expect(out).toContain("PLAIN=goodbye");
    expect(out.split("\n").length).toBe(SAMPLE.split("\n").length);
  });

  it("quotes a value that would otherwise change meaning", () => {
    const out = serializeEnv(
      setEntryValue(parseEnv("A=x\n"), "A", "has spaces # and hash"),
    );
    expect(out).toBe('A="has spaces # and hash"\n');
    expect(parseEnv(out)[0]).toMatchObject({ value: "has spaces # and hash" });
  });

  it("keeps the export prefix when the value changes", () => {
    expect(
      serializeEnv(setEntryValue(parseEnv("export A=1\n"), "A", "2")),
    ).toBe("export A=2\n");
  });

  it("adds and removes entries", () => {
    expect(serializeEnv(addEntry(parseEnv("A=1\n"), "B", "2"))).toBe(
      "A=1\nB=2\n",
    );
    expect(serializeEnv(removeEntry(parseEnv("A=1\nB=2\n"), "A"))).toBe(
      "B=2\n",
    );
  });

  it("preserves non-canonical formatting that renderEntry would normalize", () => {
    const nonCanonical =
      'export  SPACED=value\nA=value   \nB="quoted"  \nC=plain\n';
    expect(serializeEnv(parseEnv(nonCanonical))).toBe(nonCanonical);
  });

  it("round-trips values with special characters via set/parse cycle", () => {
    const cases = [
      { value: 'has"quote', desc: "double quote" },
      { value: "a\\b", desc: "backslash" },
      { value: 'has"quote\\and\\backslash', desc: "both" },
      { value: "has'single", desc: "single quote" },
      { value: "has spaces # and hash", desc: "spaces and hash" },
      { value: "ends\\", desc: "trailing backslash" },
      { value: "\\", desc: "single backslash" },
      { value: "\\\\", desc: "double backslash" },
    ];
    for (const { value, desc } of cases) {
      const lines = parseEnv("A=x\n");
      const modified = setEntryValue(lines, "A", value);
      const serialized = serializeEnv(modified);
      const reparsed = parseEnv(serialized);
      const entry = reparsed.find((l) => l.kind === "entry" && l.key === "A");
      if (entry?.kind !== "entry")
        throw new Error(`Expected entry, got ${entry?.kind}`);
      expect(entry.value, desc).toBe(value);
    }
  });

  it("parses pre-existing quoted values with trailing backslashes", () => {
    const cases = [
      { input: 'A="ends\\\\"\n', value: "ends\\", desc: "trailing backslash" },
      { input: 'A="\\\\"\n', value: "\\", desc: "single backslash" },
      { input: 'A="\\\\\\\\"\n', value: "\\\\", desc: "double backslash" },
    ];
    for (const { input, value, desc } of cases) {
      const parsed = parseEnv(input);
      const entry = parsed.find((l) => l.kind === "entry" && l.key === "A");
      if (entry?.kind !== "entry")
        throw new Error(`Expected entry, got ${entry?.kind} for ${desc}`);
      expect(entry.value, desc).toBe(value);
    }
  });

  it("round-trips pre-existing multi-line values untouched", () => {
    const multiLine = 'MULTI="line one\nline two"\n';
    const parsed = parseEnv(multiLine);
    expect(parsed[0]?.kind).toBe("other"); // Parser doesn't model it
    expect(serializeEnv(parsed)).toBe(multiLine); // But it round-trips
  });

  it("rejects newlines in setEntryValue and addEntry", () => {
    expect(() => setEntryValue(parseEnv("A=x\n"), "A", "has\nnewline")).toThrow(
      /newline/,
    );
    expect(() => addEntry(parseEnv(""), "A", "has\nnewline")).toThrow(
      /newline/,
    );
    expect(() => setEntryValue(parseEnv("A=x\n"), "A", "has\rCR")).toThrow(
      /newline/,
    );
    expect(() => addEntry(parseEnv(""), "A", "has\rCR")).toThrow(/newline/);
  });
});

describe("isSecretKey", () => {
  it("flags names that usually hold credentials", () => {
    for (const k of ["DB_PASSWORD", "API_KEY", "JWT_SECRET", "ADMIN_TOKEN"])
      expect(isSecretKey(k), k).toBe(true);
  });
  it("does not flag ordinary settings", () => {
    for (const k of ["TZ", "PUID", "UPLOAD_LOCATION"])
      expect(isSecretKey(k), k).toBe(false);
  });
});
