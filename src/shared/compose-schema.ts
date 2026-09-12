/**
 * A small walk over the compose JSON Schema, in place of a validation library.
 *
 * We need exactly two things from the schema — the keys valid at a cursor's path, and each
 * key's description and enum — and both are a tree walk. Pulling in `ajv` plus its 2020-12
 * dialect to duplicate a check the server already does properly, on a bundle shipped to a
 * browser, is a poor trade. Semantics stay with `docker compose config`, which the spec
 * already designates as the authority: only resolution knows that `depends_on: [databse]`
 * names nothing.
 */
export type SchemaSuggestion = { label: string; detail?: string; docs?: string };

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isArrayish = (node: Node): boolean =>
  node.type === "array" ||
  (Array.isArray(node.type) && node.type.includes("array")) ||
  node.items !== undefined ||
  node.prefixItems !== undefined;

/**
 * Expands one schema node into the concrete alternative nodes it can mean: follows a local
 * `$ref` chain, then — if the target is a `oneOf`/`anyOf`/`allOf` — flattens each branch
 * recursively. We never decide which branch the document actually satisfies; that is
 * validation, and the spec designates `docker compose config` as the authority for it. For
 * completion and unknown-key purposes every branch is a legitimate possibility, so the
 * caller gets all of them and merges.
 *
 * `visiting` is the chain of `$ref`s followed to reach this call, not a set shared across a
 * whole path walk. Scoping it to the chain (rather than one flat set for an entire `nodeAt`
 * call) means two different path segments that legitimately resolve through the same `$ref`
 * both succeed — only an actual cycle (a ref reappearing in its own ancestor chain) is
 * refused. Refusing a real cycle is what keeps a self-referential schema from hanging the
 * editor.
 */
function resolveNode(root: unknown, node: unknown, visiting: ReadonlySet<string>): Node[] {
  if (!isNode(node)) return [];

  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    if (!ref.startsWith("#/") || visiting.has(ref)) return [];
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      if (!isNode(target)) return [];
      target = target[part];
    }
    const chain = new Set(visiting);
    chain.add(ref);
    return resolveNode(root, target, chain);
  }

  const combinators = [node.oneOf, node.anyOf, node.allOf].filter((c): c is unknown[] =>
    Array.isArray(c),
  );
  if (combinators.length === 0) return [node];

  const branches: Node[] = [];
  // A node can (rarely) carry its own schema keywords alongside a combinator. Keep it as a
  // candidate too, rather than discarding it in favour of only the combinator's branches.
  if (
    isNode(node.properties) ||
    isNode(node.patternProperties) ||
    node.items !== undefined ||
    Array.isArray(node.enum)
  ) {
    branches.push(node);
  }
  for (const list of combinators) {
    for (const branch of list) {
      branches.push(...resolveNode(root, branch, visiting));
    }
  }
  return branches;
}

/**
 * The raw (not yet `$ref`/combinator-resolved) subschemas one key addresses off an already-
 * resolved node: `properties`, then `patternProperties` (service, volume and network names
 * are user-chosen, so they are matched by pattern rather than listed — without this branch
 * nothing inside a service ever completes), then `additionalProperties`.
 *
 * A numeric path segment falls through to `items`/`prefixItems` only once those mapping
 * shapes have all failed to claim the key — a service can legally be named `8080`, so a
 * numeric key must resolve as a map entry first and only mean a sequence index when the node
 * actually describes an array.
 */
function candidatesFor(node: Node, key: string): unknown[] {
  const properties = node.properties;
  if (isNode(properties) && key in properties) return [properties[key]];

  const patterns = node.patternProperties;
  if (isNode(patterns)) {
    for (const [pattern, sub] of Object.entries(patterns)) {
      try {
        if (new RegExp(pattern).test(key)) return [sub];
      } catch {
        // An unparseable pattern in the schema is upstream's problem, not a crash here.
      }
    }
  }

  if (isNode(node.additionalProperties)) return [node.additionalProperties];

  if (/^\d+$/.test(key) && isArrayish(node)) {
    if (Array.isArray(node.prefixItems)) {
      const index = Number(key);
      if (index < node.prefixItems.length) return [node.prefixItems[index]];
      if (node.items !== undefined) return [node.items];
      return [];
    }
    if (node.items !== undefined) return [node.items];
  }

  return [];
}

/**
 * All schema nodes a path can mean, after fully expanding every `$ref` and `oneOf`/`anyOf`/
 * `allOf` encountered along the way. Empty means the path is not described by the schema at
 * all — not even by one branch.
 */
function nodeAt(schema: unknown, path: string[]): Node[] {
  let candidates = resolveNode(schema, schema, new Set());
  for (const key of path) {
    const next: Node[] = [];
    for (const candidate of candidates) {
      for (const raw of candidatesFor(candidate, key)) {
        next.push(...resolveNode(schema, raw, new Set()));
      }
    }
    if (next.length === 0) return [];
    candidates = next;
  }
  return candidates;
}

export function keysAt(schema: unknown, path: string[]): SchemaSuggestion[] {
  const byLabel = new Map<string, SchemaSuggestion>();
  for (const node of nodeAt(schema, path)) {
    if (!isNode(node.properties)) continue;
    for (const [label, value] of Object.entries(node.properties)) {
      const suggestion: SchemaSuggestion = {
        label,
        detail: isNode(value) && typeof value.type === "string" ? value.type : undefined,
        docs:
          isNode(value) && typeof value.description === "string" ? value.description : undefined,
      };
      // Two branches can describe the same key (e.g. a property present under more than one
      // `oneOf` alternative). Prefer whichever carries a description, since hover docs are
      // the point.
      const existing = byLabel.get(label);
      if (!existing || (!existing.docs && suggestion.docs)) byLabel.set(label, suggestion);
    }
  }
  return [...byLabel.values()];
}

export function enumsAt(schema: unknown, path: string[]): SchemaSuggestion[] {
  const labels = new Set<string>();
  for (const node of nodeAt(schema, path)) {
    if (!Array.isArray(node.enum)) continue;
    for (const value of node.enum) {
      if (typeof value === "string") labels.add(value);
    }
  }
  return [...labels].map((label) => ({ label }));
}

export function isKnownPath(schema: unknown, path: string[]): boolean {
  return nodeAt(schema, path).length > 0;
}
