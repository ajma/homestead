import type { CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { declaredNames, documentCompletion } from "./document-completion";

function contextAt(text: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc: text, selection: { anchor: pos } });
  return new CompletionContext(state, pos, explicit);
}

// Mirrors schema-completion.test.ts's `complete` helper: `CompletionSource` is typed to
// allow an async result even though this implementation is always synchronous.
async function complete(
  source: CompletionSource,
  context: CompletionContext,
): Promise<CompletionResult | null> {
  return await source(context);
}

describe("declaredNames", () => {
  it("extracts service, volume and network names from a document", () => {
    const doc = [
      "services:",
      "  web:",
      "    image: nginx",
      "  db:",
      "    image: postgres",
      "volumes:",
      "  data:",
      "  cache:",
      "networks:",
      "  frontend:",
    ].join("\n");

    expect(declaredNames(doc)).toEqual({
      services: ["web", "db"],
      volumes: ["data", "cache"],
      networks: ["frontend"],
    });
  });

  it("returns empty lists for a document with none of the three sections", () => {
    const doc = "x-notes:\n  anything: here\n";
    expect(declaredNames(doc)).toEqual({ services: [], volumes: [], networks: [] });
  });

  it("returns empty lists for an empty document", () => {
    expect(declaredNames("")).toEqual({ services: [], volumes: [], networks: [] });
  });

  it("ignores a depends_on list nested inside a service (its items are not service declarations)", () => {
    const doc = [
      "services:",
      "  web:",
      "    depends_on:",
      "      - db",
      "  db:",
      "    image: redis",
    ].join("\n");

    expect(declaredNames(doc).services).toEqual(["web", "db"]);
  });

  it("does not descend into a service's own nested keys when collecting service names", () => {
    // `web`'s `deploy.replicas` and `ports` must not leak into the services list —
    // only direct children of the top-level `services:` mapping count.
    const doc = [
      "services:",
      "  web:",
      "    deploy:",
      "      replicas: 2",
      "    ports:",
      "      - 80:80",
    ].join("\n");

    expect(declaredNames(doc).services).toEqual(["web"]);
  });

  it("still finds what it can in a half-typed document", () => {
    // This runs while the user is mid-keystroke, so the document is invalid far more often
    // than it is valid. A parser that throws here means completions vanish exactly when
    // someone is typing, which is the only time they are wanted.
    const broken = "services:\n  web:\n    image: nginx\n  db\n";
    expect(() => declaredNames(broken)).not.toThrow();
    expect(declaredNames(broken).services).toContain("web");
  });

  it("tolerates a document that is nothing but a dangling key", () => {
    expect(() => declaredNames("services:\n  web\n    ")).not.toThrow();
  });
});

describe("documentCompletion", () => {
  const DOC = [
    "services:",
    "  web:",
    "    image: nginx",
    "    depends_on:",
    "      - ",
    "    volumes:",
    "      - ",
    "    networks:",
    "      - ",
    "  db:",
    "    image: postgres",
    "  cache:",
    "    image: redis",
    "volumes:",
    "  data:",
    "  logs:",
    "networks:",
    "  frontend:",
    "  backend:",
  ].join("\n");

  it("offers the other service names inside a depends_on list, excluding the current service", async () => {
    const source = documentCompletion();
    const pos = DOC.indexOf("- \n    volumes") + 2;
    const result = await complete(source, contextAt(DOC, pos, true));
    expect(result?.options.map((o) => o.label)).toEqual(expect.arrayContaining(["db", "cache"]));
    expect(result?.options.map((o) => o.label)).not.toContain("web");
  });

  it("offers declared top-level volumes under a service's volumes list", async () => {
    const source = documentCompletion();
    const pos = DOC.indexOf("- \n    networks") + 2;
    const result = await complete(source, contextAt(DOC, pos, true));
    expect(result?.options.map((o) => o.label)).toEqual(expect.arrayContaining(["data", "logs"]));
  });

  it("offers declared top-level networks under a service's networks list", async () => {
    const source = documentCompletion();
    const pos = DOC.indexOf("- \n  db:") + 2;
    const result = await complete(source, contextAt(DOC, pos, true));
    expect(result?.options.map((o) => o.label)).toEqual(
      expect.arrayContaining(["frontend", "backend"]),
    );
  });

  it("offers nothing elsewhere", async () => {
    const source = documentCompletion();
    const pos = DOC.indexOf("image: nginx");
    const result = await complete(source, contextAt(DOC, pos, true));
    expect(result).toBeNull();
  });

  it("offers nothing when there is only one service (nothing else to depend on)", async () => {
    const doc = ["services:", "  web:", "    depends_on:", "      - "].join("\n");
    const source = documentCompletion();
    const result = await complete(source, contextAt(doc, doc.length, true));
    expect(result).toBeNull();
  });
});
