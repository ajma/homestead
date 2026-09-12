import type { CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { envCompletion } from "./env-completion";

function contextAt(text: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc: text, selection: { anchor: pos } });
  return new CompletionContext(state, pos, explicit);
}

async function complete(
  source: CompletionSource,
  context: CompletionContext,
): Promise<CompletionResult | null> {
  return await source(context);
}

describe("envCompletion", () => {
  it("offers the supplied keys after ${", async () => {
    const source = envCompletion(() => ["DB_HOST", "DB_PORT"]);
    const text = "image: ${";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.options.map((o) => o.label)).toEqual(
      expect.arrayContaining(["DB_HOST", "DB_PORT"]),
    );
  });

  it("replaces from just after the ${, not the ${ itself", async () => {
    const source = envCompletion(() => ["DB_HOST"]);
    const text = "image: ${";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.from).toBe(text.length);
  });

  it("offers nothing without a preceding ${", async () => {
    const source = envCompletion(() => ["DB_HOST"]);
    const text = "image: nginx:";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result).toBeNull();
  });

  it("calls the keys function lazily, once per completion request", async () => {
    let calls = 0;
    const source = envCompletion(() => {
      calls++;
      return ["DB_HOST"];
    });
    expect(calls).toBe(0);
    const text = "${";
    await complete(source, contextAt(text, text.length, true));
    expect(calls).toBe(1);
  });

  it("picks up keys that change between calls, since the source is a live function", async () => {
    let keys = ["DB_HOST"];
    const source = envCompletion(() => keys);
    const text = "${";

    const first = await complete(source, contextAt(text, text.length, true));
    expect(first?.options.map((o) => o.label)).toEqual(["DB_HOST"]);

    keys = ["DB_HOST", "DB_PORT"];
    const second = await complete(source, contextAt(text, text.length, true));
    expect(second?.options.map((o) => o.label)).toEqual(
      expect.arrayContaining(["DB_HOST", "DB_PORT"]),
    );
  });

  it("flags a fully-typed variable name that is not defined in .env", async () => {
    const source = envCompletion(() => ["DB_HOST"]);
    const text = "${DB_PASWORD";
    const result = await complete(source, contextAt(text, text.length, true));
    const flagged = result?.options.find((o) => o.label === "DB_PASWORD");
    expect(flagged?.detail).toBe("not defined in .env");
  });

  it("does not flag a defined key", async () => {
    const source = envCompletion(() => ["DB_HOST"]);
    const text = "${DB_HOST";
    const result = await complete(source, contextAt(text, text.length, true));
    const match = result?.options.find((o) => o.label === "DB_HOST");
    expect(match?.detail).not.toBe("not defined in .env");
  });

  it("does not flag a partial prefix of a real key while still typing it", async () => {
    const source = envCompletion(() => ["DB_HOST"]);
    const text = "${DB_";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.options.map((o) => o.label)).not.toContain("DB_");
  });

  it("flags an empty-list lookup once the typed name diverges from anything real", async () => {
    const source = envCompletion(() => []);
    const text = "${ANYTHING";
    const result = await complete(source, contextAt(text, text.length, true));
    const flagged = result?.options.find((o) => o.label === "ANYTHING");
    expect(flagged?.detail).toBe("not defined in .env");
  });

  it("offers nothing after $${, since $$ is compose's escape for a literal $", async () => {
    const source = envCompletion(() => ["DB_HOST"]);
    const text = "image: $${";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result).toBeNull();
  });

  it("still triggers on a plain ${", async () => {
    const source = envCompletion(() => ["DB_HOST"]);
    const text = "image: ${";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.options.map((o) => o.label)).toEqual(expect.arrayContaining(["DB_HOST"]));
  });

  it("triggers on $$${, since the first two $ escape each other and the third opens an interpolation", async () => {
    const source = envCompletion(() => ["DB_HOST"]);
    const text = "image: $$${";
    const result = await complete(source, contextAt(text, text.length, true));
    expect(result?.options.map((o) => o.label)).toEqual(expect.arrayContaining(["DB_HOST"]));
  });

  it("never reaches for anything beyond a key name (no secret values pass through)", async () => {
    // envCompletion's whole contract is that it takes `keys: () => string[]` — plain
    // names, never values. This test exists to make a future signature change (e.g.
    // threading through masked entries with a `value` field) visibly break here
    // instead of silently starting to render secrets in a completion popup.
    const source = envCompletion(() => ["DB_HOST"]);
    const text = "${";
    const result = await complete(source, contextAt(text, text.length, true));
    for (const option of result?.options ?? []) {
      expect(Object.keys(option)).not.toContain("value");
    }
  });
});
