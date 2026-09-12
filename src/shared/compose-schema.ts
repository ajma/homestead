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

/**
 * Resolves a local `$ref`. Only `#/`-rooted refs, which is all the compose schema uses;
 * a remote ref would mean a network fetch, and this file must work offline.
 */
function deref(root: unknown, node: unknown, seen: Set<string>): unknown {
  let current = node;
  while (isNode(current) && typeof current.$ref === "string") {
    const ref = current.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) return undefined;
    seen.add(ref);
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      if (!isNode(target)) return undefined;
      target = target[part];
    }
    current = target;
  }
  return current;
}

/** The subschema addressed by one key, following `properties` then `patternProperties`. */
function childOf(root: unknown, node: unknown, key: string, seen: Set<string>): unknown {
  const resolved = deref(root, node, seen);
  if (!isNode(resolved)) return undefined;

  const properties = resolved.properties;
  if (isNode(properties) && key in properties) return properties[key];

  // Service, volume and network names are user-chosen, so they are matched by pattern
  // rather than listed. Without this branch nothing inside a service ever completes.
  const patterns = resolved.patternProperties;
  if (isNode(patterns)) {
    for (const [pattern, sub] of Object.entries(patterns)) {
      try {
        if (new RegExp(pattern).test(key)) return sub;
      } catch {
        // An unparseable pattern in the schema is upstream's problem, not a crash here.
      }
    }
  }

  if (isNode(resolved.additionalProperties)) return resolved.additionalProperties;
  return undefined;
}

function nodeAt(schema: unknown, path: string[]): unknown {
  const seen = new Set<string>();
  let node: unknown = schema;
  for (const key of path) {
    node = childOf(schema, node, key, seen);
    if (node === undefined) return undefined;
  }
  return deref(schema, node, seen);
}

export function keysAt(schema: unknown, path: string[]): SchemaSuggestion[] {
  const node = nodeAt(schema, path);
  if (!isNode(node) || !isNode(node.properties)) return [];
  return Object.entries(node.properties).map(([label, value]) => ({
    label,
    detail: isNode(value) && typeof value.type === "string" ? value.type : undefined,
    docs: isNode(value) && typeof value.description === "string" ? value.description : undefined,
  }));
}

export function enumsAt(schema: unknown, path: string[]): SchemaSuggestion[] {
  const node = nodeAt(schema, path);
  if (!isNode(node) || !Array.isArray(node.enum)) return [];
  return node.enum.filter((v): v is string => typeof v === "string").map((label) => ({ label }));
}

export function isKnownPath(schema: unknown, path: string[]): boolean {
  return nodeAt(schema, path) !== undefined;
}
