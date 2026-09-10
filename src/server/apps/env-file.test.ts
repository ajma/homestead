import { maskEnv, parseEnv, serialiseEnv, upsertEnv } from "@server/apps/env-file";
import { describe, expect, it } from "vitest";

const sample = [
  "# Database credentials",
  "DB_PASSWORD=hunter2",
  "",
  "PUID=1000   # the media user",
  "EMPTY=",
  'QUOTED="has spaces"',
  "#DISABLED=not-active",
].join("\n");

describe("parseEnv / serialiseEnv", () => {
  it("round-trips byte-for-byte", () => {
    expect(serialiseEnv(parseEnv(sample))).toBe(sample);
  });

  it("extracts pairs and preserves everything else verbatim", () => {
    const entries = parseEnv(sample);
    const pairs = entries.filter((e) => e.kind === "pair");
    expect(pairs.map((p) => p.kind === "pair" && p.key)).toEqual([
      "DB_PASSWORD",
      "PUID",
      "EMPTY",
      "QUOTED",
    ]);
    // A commented-out assignment is a comment, not a pair.
    expect(pairs.some((p) => p.kind === "pair" && p.key === "DISABLED")).toBe(false);
  });

  it("keeps an empty value distinct from an absent key", () => {
    const empty = parseEnv(sample).find((e) => e.kind === "pair" && e.key === "EMPTY");
    expect(empty?.kind === "pair" && empty.value).toBe("");
  });

  it("round-trips a file with no trailing newline", () => {
    expect(serialiseEnv(parseEnv("A=1"))).toBe("A=1");
  });

  it("round-trips a file with a trailing newline", () => {
    expect(serialiseEnv(parseEnv("A=1\n"))).toBe("A=1\n");
  });
});

describe("maskEnv", () => {
  it("never returns a value", () => {
    const masked = maskEnv(parseEnv(sample));
    expect(JSON.stringify(masked)).not.toContain("hunter2");
    expect(JSON.stringify(masked)).not.toContain("has spaces");
  });

  it("reports each key with a fixed-width mask, leaking no length", () => {
    const masked = maskEnv(parseEnv("SHORT=a\nLONG=aaaaaaaaaaaaaaaaaaaaaaaa"));
    expect(masked).toEqual([
      { key: "SHORT", masked: "••••••••" },
      { key: "LONG", masked: "••••••••" },
    ]);
  });

  it("distinguishes an empty value, which is not a secret", () => {
    expect(maskEnv(parseEnv("EMPTY="))).toEqual([{ key: "EMPTY", masked: "" }]);
  });
});

describe("values", () => {
  it("reads the value compose would read, not the whole right-hand side", () => {
    const byKey = (content: string, key: string) => {
      const entry = parseEnv(content).find((e) => e.kind === "pair" && e.key === key);
      return entry?.kind === "pair" ? entry.value : undefined;
    };
    // An inline comment is not part of the value...
    expect(byKey(sample, "PUID")).toBe("1000");
    // ...but a '#' with no whitespace before it is.
    expect(byKey("PASS=hunter#2", "PASS")).toBe("hunter#2");
    // ...and one inside quotes is literal.
    expect(byKey('PASS="a # b"', "PASS")).toBe("a # b");
    // One layer of matching quotes is removed.
    expect(byKey(sample, "QUOTED")).toBe("has spaces");
    expect(byKey("S='single'", "S")).toBe("single");
    // Mismatched quotes are not a pair of quotes.
    expect(byKey("M=\"oops'", "M")).toBe("\"oops'");
  });

  it("captures the inline comment with its leading whitespace", () => {
    const puid = parseEnv(sample).find((e) => e.kind === "pair" && e.key === "PUID");
    expect(puid?.kind === "pair" && puid.comment).toBe("   # the media user");
  });
});

describe("upsertEnv", () => {
  it("updates in place, preserving position and surrounding lines", () => {
    const updated = upsertEnv(parseEnv(sample), "PUID", "1001");
    const text = serialiseEnv(updated);
    expect(text).toContain("PUID=1001");
    expect(text).toContain("# Database credentials");
    expect(text.indexOf("PUID")).toBeLessThan(text.indexOf("EMPTY"));
  });

  it("keeps the inline comment when the value it annotates changes", () => {
    // The whole point of the module: editing one variable must not silently delete
    // the note explaining why it is set. Without this, `PUID=1001` is all that is left.
    const text = serialiseEnv(upsertEnv(parseEnv(sample), "PUID", "1001"));
    expect(text).toContain("PUID=1001   # the media user");
  });

  it("quotes a written value only when it would not survive unquoted", () => {
    expect(serialiseEnv(upsertEnv(parseEnv("A=1"), "A", "plain"))).toBe("A=plain");
    expect(serialiseEnv(upsertEnv(parseEnv("A=1"), "A", "has spaces"))).toBe('A="has spaces"');
    expect(serialiseEnv(upsertEnv(parseEnv("A=1"), "A", "a#b"))).toBe('A="a#b"');
    // A quote in the value is escaped, so re-parsing yields what was written.
    const written = serialiseEnv(upsertEnv(parseEnv("A=1"), "A", 'say "hi"'));
    const back = parseEnv(written).find((e) => e.kind === "pair");
    expect(back?.kind === "pair" && back.value).toBe('say "hi"');
  });

  it("appends a new key at the end", () => {
    const text = serialiseEnv(upsertEnv(parseEnv("A=1\n"), "B", "2"));
    expect(text).toBe("A=1\nB=2\n");
  });
});
