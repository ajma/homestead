# Homestead Phase 1F — Compose and `.env` Editors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin edit a stack's `compose.yaml` and `.env` from inside Homestead, with enough help that they do not have to remember the compose schema and enough safety that they cannot silently clobber a file someone changed over SSH.

**Architecture:** CodeMirror 6 for the compose file, with completions driven by a compose schema vendored at a pinned commit and walked by our own code rather than a JSON Schema library. Lint is two-layer: an instant client-side YAML parse, and a debounced round trip to `docker compose config`, which is the authority for anything the schema cannot know. The `.env` editor is a masked table over the existing entry parser, so comments and formatting survive an edit, with a raw mode for bulk paste.

**Tech Stack:** React 19, TanStack Query 5, Tailwind 4, CodeMirror 6, `yaml`, Fastify, Drizzle + libSQL, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-09-homestead-design.md` — section 8, "Compose editor".

**Carry-forward this plan must respect:** `docs/superpowers/plans/2026-09-11-homestead-1e-carry-forward.md`, and through it 1B-ii's, 1C's and 1D's.

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess`; ESM with `.js` import specifiers on server relative imports; `moduleResolution: bundler`; no `baseUrl`; `target: ES2022` / `lib: ES2023`.
- **Three new dependencies are permitted, and only these three:** `codemirror@6.0.2`, `@codemirror/lang-yaml@6.1.3`, `yaml@2.9.1`. The spec names CodeMirror by name and argues for it over Monaco on size and touch usability. **No `ajv` and no other JSON Schema library** — see the ruling below. Anything else is a new dependency and is not allowed.
- zod 4 for request validation. Vitest for tests. Biome for lint and format.
- Every non-2xx response body carries an `error` slug.
- `inScope` / `visibleAppsWhere` / `canForApp` remain the only scope predicates.
- **Every `.tsx` test file starts with `// @vitest-environment jsdom`.** `environmentMatchGlobs` does not exist in Vitest 5; `src/web/test-environment.test.ts` enforces the docblock, and forgetting it is silent for any test that never renders.
- Check Biome by exit code, never by piping to `tail`: `pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"`.
- `pnpm exec tsc --noEmit` is a separate gate: **vitest does not typecheck.**
- `pnpm build` must succeed — this phase adds a large dependency to the browser bundle and that is the only gate that exercises it.
- Run the full suite at least **three times** before believing it green.
- Editing compose and `.env` requires `app:config` and `app:secrets` respectively. A viewer reaches neither.

---

## Rulings made while writing this plan

**1. No JSON Schema validation library.** The spec asks for "client-side YAML parse plus schema validation for instant feedback", and in the same paragraph says schema-only "feels responsive and lets real breakage through" — which is why the server round trip exists and is the authority. Adding `ajv` plus its 2020-12 dialect to the browser bundle to duplicate a check the server already does properly is a poor trade. Instead we **walk the vendored schema ourselves**: it is a plain JSON object, and the two things we actually need from it — the valid keys at a cursor's path, and each key's `description` and `enum` — are a tree walk. Unknown-key warnings come from the same walk. Everything semantic stays with `docker compose config`.

**2. The vendored schema is checked in, refreshed by a script, and pinned by commit SHA.** The spec is explicit that it must not be fetched at runtime: the NAS may be offline, and an upstream edit should not silently change editor behaviour. So the JSON lives in the repo, a script updates it, and the pinned SHA lives beside it where a reviewer can see it move.

**3. `POST /api/apps/:id/env/reveal` gains an optional `key`.** The spec asks for reveal *per row*, and the endpoint currently returns the whole file with a single audit line. Without a per-key mode the client must hold every secret in memory to show one, and the audit record says "revealed" when the admin saw one variable. Neither is what the spec describes. The whole-file mode stays, because raw mode needs it.

**4. The compose editor is one CodeMirror instance, always mounted while the tab is.** Tabs are the data-loading boundary and this tab owns a large editor; mounting and destroying it per keystroke or per completion source would be worse than the bundle it costs.

**5. The `.env` table edits entries, not text.** `parseEnv`/`upsertEnv`/`serialiseEnv` already round-trip comments and formatting byte-for-byte, and `upsertEnv`'s docstring records that dropping an inline comment "would make editing one variable destroy the note explaining why it is set". A table that rebuilds the file from key-value pairs would throw all of that away. Raw mode is the escape hatch and edits text directly.

---

## File Structure

**Server — new:** `scripts/vendor-compose-schema.ts` (refresh the pinned schema), `src/server/schema/compose-spec.json` (vendored, checked in), `src/server/schema/PINNED.md` (the SHA and how to refresh).

**Server — modified:** `src/server/routes/apps.ts` (per-key reveal).

**Shared — new:** `src/shared/compose-schema.ts` — the schema walk. Pure, no CodeMirror, no DOM, so it is testable in node and usable from either zone.

**Web — new:**

| File | Responsibility |
|---|---|
| `src/web/editor/YamlEditor.tsx` | The CodeMirror instance. Controlled value, diagnostics in, extensions in. |
| `src/web/editor/yaml-lint.ts` | Layer one: parse with `yaml`, map errors to diagnostics. |
| `src/web/editor/schema-completion.ts` | Keys, enums and hover docs from the vendored schema. |
| `src/web/editor/document-completion.ts` | Service names, volumes and networks from the buffer. |
| `src/web/editor/env-completion.ts` | `${` completions from the sibling `.env`, flagging undefined keys. |
| `src/web/editor/desktop-only.ts` | `(pointer: fine)` plus a width check. |
| `src/web/editor/use-server-validate.ts` | Layer two: debounced `POST /compose/validate`. |
| `src/web/routes/edit/ComposeTab.tsx` | Load, edit, save, hash conflict. |
| `src/web/routes/edit/EnvTab.tsx` | Masked table, per-row reveal, raw mode, save. |

**Web — modified:** `src/web/App.tsx` and `src/web/routes/EditApp.tsx` (two new tab routes), `src/web/api/admin.ts` (compose and env hooks).

---

### Task 1: Vendor the compose schema at a pinned commit

**Files:**
- Create: `scripts/vendor-compose-schema.ts`, `src/server/schema/compose-spec.json`, `src/server/schema/PINNED.md`
- Test: `src/shared/compose-schema-vendored.test.ts`

**Interfaces:**
- Produces: `src/server/schema/compose-spec.json`, importable as JSON; `PINNED.md` recording the upstream commit.

- [ ] **Step 1: Write the failing test**

`src/shared/compose-schema-vendored.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = JSON.parse(readFileSync("src/server/schema/compose-spec.json", "utf8"));

describe("the vendored compose schema", () => {
  it("is JSON Schema draft 2020-12", () => {
    expect(String(schema.$schema)).toContain("2020-12");
  });

  it("declares the top-level compose keys the editor completes against", () => {
    for (const key of ["services", "volumes", "networks"]) {
      expect(Object.keys(schema.properties ?? {})).toContain(key);
    }
  });

  it("carries a service definition with descriptions, which is where hover docs come from", () => {
    // The spec's claim, verified rather than trusted: 93 service properties of which 89
    // carry descriptions. If a refresh drops descriptions, hover docs silently vanish and
    // nothing else would notice.
    const service = schema.$defs?.service?.properties ?? {};
    expect(Object.keys(service).length).toBeGreaterThan(50);
    const described = Object.values(service).filter(
      (p) => typeof (p as { description?: unknown }).description === "string",
    );
    expect(described.length).toBeGreaterThan(Object.keys(service).length * 0.8);
  });

  it("records the commit it was vendored from", () => {
    // Not fetched at runtime: the NAS may be offline, and an upstream edit must not
    // silently change editor behaviour. The pin is what makes that true.
    const pinned = readFileSync("src/server/schema/PINNED.md", "utf8");
    expect(pinned).toMatch(/[0-9a-f]{40}/);
  });

  it("is small enough to ship to a browser", () => {
    // Roughly 76 KB. An order of magnitude larger would mean upstream restructured and
    // the walk in `@shared/compose-schema` probably needs revisiting too.
    expect(readFileSync("src/server/schema/compose-spec.json").byteLength).toBeLessThan(300_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/shared/compose-schema-vendored.test.ts`
Expected: FAIL — `ENOENT` on `compose-spec.json`.

- [ ] **Step 3: Write the vendoring script**

`scripts/vendor-compose-schema.ts`. It resolves a ref to a commit SHA, downloads that exact SHA's `schema/compose-spec.json`, writes the JSON and a `PINNED.md` beside it. It is run by a human, not by the build — the build must never reach the network.

```ts
/**
 * Refreshes the vendored compose schema.
 *
 * Run by hand, never by the build: `pnpm exec tsx scripts/vendor-compose-schema.ts [ref]`.
 * The spec requires the schema be vendored at a pinned commit rather than fetched at
 * runtime, because the NAS may be offline and an upstream edit should not silently change
 * what the editor considers a valid key.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const REPO = "compose-spec/compose-spec";
const OUT = resolve("src/server/schema/compose-spec.json");

async function main() {
  const ref = process.argv[2] ?? "main";

  const commitResponse = await fetch(`https://api.github.com/repos/${REPO}/commits/${ref}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!commitResponse.ok) throw new Error(`Could not resolve ${ref}: ${commitResponse.status}`);
  const sha = (await commitResponse.json()).sha as string;
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Unexpected sha: ${sha}`);

  const raw = await fetch(
    `https://raw.githubusercontent.com/${REPO}/${sha}/schema/compose-spec.json`,
  );
  if (!raw.ok) throw new Error(`Could not download schema at ${sha}: ${raw.status}`);
  const text = await raw.text();

  // Parse before writing. A 404 page or a truncated download is still a 200 with a body,
  // and a corrupt schema would break completions everywhere with no obvious cause.
  const parsed = JSON.parse(text);
  if (typeof parsed?.properties?.services !== "object") {
    throw new Error("Downloaded file does not look like the compose schema");
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await writeFile(
    resolve(dirname(OUT), "PINNED.md"),
    `# Vendored compose schema\n\n` +
      `Source: https://github.com/${REPO}\n` +
      `Commit: ${sha}\n` +
      `Vendored: ${new Date().toISOString().slice(0, 10)}\n\n` +
      `Refresh with:\n\n    pnpm exec tsx scripts/vendor-compose-schema.ts <ref>\n\n` +
      `Then run the suite. \`compose-schema-vendored.test.ts\` checks the shape the\n` +
      `completion walk depends on, so a breaking upstream restructure fails there rather\n` +
      `than silently emptying the editor's suggestions.\n`,
    "utf8",
  );
  console.log(`Vendored ${REPO}@${sha}`);
}

await main();
```

- [ ] **Step 4: Run the script**

Run: `pnpm exec tsx scripts/vendor-compose-schema.ts`

If the network is unavailable, say so and stop — this task cannot be completed offline, and inventing a schema by hand would be worse than not doing it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run src/shared/compose-schema-vendored.test.ts`
Expected: all pass. If the descriptions assertion fails, report the real ratio rather than lowering the threshold — that would mean the spec's premise for hover docs no longer holds.

- [ ] **Step 6: Confirm the build does not fetch**

Run: `pnpm build`, then grep the script for any import of it from `src/`. Nothing under `src/` may import `scripts/`.

- [ ] **Step 7: Commit**

```bash
git add scripts/vendor-compose-schema.ts src/server/schema/ src/shared/compose-schema-vendored.test.ts
git commit -m "Vendor the compose schema at a pinned commit, so an offline NAS still completes"
```

---

### Task 2: Reveal one `.env` value at a time

The spec asks for reveal *per row*. The endpoint returns the whole file with one audit line, so today the client would have to hold every secret in memory to show one, and the audit would record "revealed" when the admin saw a single variable.

**Files:**
- Modify: `src/server/routes/apps.ts`
- Test: `src/server/routes/apps-env.test.ts` (extend)

**Interfaces:**
- Produces: `POST /api/apps/:id/env/reveal` accepting an optional `{ key?: string }`. With a key it returns `{ key, value }` and audits that key; without one it returns the whole file as now.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/routes/apps-env.test.ts`:

```ts
describe("POST /api/apps/:id/env/reveal with a key", () => {
  it("returns just that key's value", async () => {
    const { app, cookie, id } = await withEnv("API_KEY=sk-live-123\nOTHER=zzz\n");
    const res = await app.inject({
      method: "POST", url: `/api/apps/${id}/env/reveal`, headers: { cookie },
      payload: { key: "API_KEY" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ key: "API_KEY", value: "sk-live-123" });
  });

  it("does not include any other key's value in the response", async () => {
    // The whole point of per-key reveal: showing one row must not ship the rest to the
    // browser, where they sit in memory and in the devtools network pane.
    const { app, cookie, id } = await withEnv("API_KEY=sk-live-123\nOTHER=secret-two\n");
    const res = await app.inject({
      method: "POST", url: `/api/apps/${id}/env/reveal`, headers: { cookie },
      payload: { key: "API_KEY" },
    });
    expect(res.body).not.toContain("secret-two");
  });

  it("records which key was revealed, not merely that something was", async () => {
    const { app, cookie, id, db } = await withEnv("API_KEY=sk-live-123\n");
    await app.inject({
      method: "POST", url: `/api/apps/${id}/env/reveal`, headers: { cookie },
      payload: { key: "API_KEY" },
    });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "app.env_revealed"));
    expect(JSON.stringify(entry?.detail)).toContain("API_KEY");
  });

  it("404s a key that is not in the file, without saying what is", async () => {
    const { app, cookie, id } = await withEnv("API_KEY=x\n");
    const res = await app.inject({
      method: "POST", url: `/api/apps/${id}/env/reveal`, headers: { cookie },
      payload: { key: "NOPE" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("key_not_found");
    expect(res.body).not.toContain("API_KEY");
  });

  it("still returns the whole file when no key is given, for raw mode", async () => {
    const { app, cookie, id } = await withEnv("API_KEY=x\nOTHER=y\n");
    const res = await app.inject({
      method: "POST", url: `/api/apps/${id}/env/reveal`, headers: { cookie }, payload: {},
    });
    expect(res.json().content).toContain("OTHER=y");
  });

  it("requires app:secrets, like the whole-file mode", async () => {
    const { app, cookie, id } = await withEnv("API_KEY=x\n");
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "POST", url: `/api/apps/${id}/env/reveal`,
      headers: { cookie: viewer.cookie }, payload: { key: "API_KEY" },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

Write `withEnv(content)` following the existing helpers in that file — read them first rather than inventing a new fixture shape.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/server/routes/apps-env.test.ts`
Expected: FAIL — the key is ignored and the whole file comes back.

- [ ] **Step 3: Implement**

In the reveal handler, parse an optional key and branch before the audit:

```ts
const body = z.object({ key: z.string().max(256).optional() }).parse(request.body ?? {});
```

With a key: find the matching `pair` entry from `parseEnv(file.content)`. If there is none, `reply.code(404).send({ error: "key_not_found" })` **before** auditing — an audit line saying a secret was revealed when it was not is worse than none, which is the reasoning already in this handler's comment for the failure case. If there is one, audit with `detail: { key }` and return `{ key, value }`.

Without a key, behave exactly as now.

- [ ] **Step 4: Run and verify**

Run: `pnpm exec vitest run src/server/routes/apps-env.test.ts`
Expected: all pass.

- [ ] **Step 5: Binding checks**

- Return the whole file even when a key is given → the "no other key's value" test must fail.
- Audit before the not-found check → the 404 test still passes, so instead assert no audit row is written for a missing key, and confirm that new assertion fails.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/apps.ts src/server/routes/apps-env.test.ts
git commit -m "Reveal one .env value at a time, and record which one"
```

---

### Task 3: Walk the schema

Pure logic. No CodeMirror, no DOM, no network. This is what makes completions possible without a JSON Schema library.

**Files:**
- Create: `src/shared/compose-schema.ts`
- Test: `src/shared/compose-schema.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SchemaSuggestion = { label: string; detail?: string; docs?: string };
  /** Keys valid at a YAML path. `["services", "web"]` yields service properties. */
  export function keysAt(schema: unknown, path: string[]): SchemaSuggestion[];
  /** Enum values valid at a path, e.g. `["services","web","restart"]`. */
  export function enumsAt(schema: unknown, path: string[]): SchemaSuggestion[];
  /** `true` when the path addresses a known key. Drives the unknown-key warning. */
  export function isKnownPath(schema: unknown, path: string[]): boolean;
  ```

- [ ] **Step 1: Write the failing test**

`src/shared/compose-schema.test.ts`:

```ts
import { keysAt, enumsAt, isKnownPath } from "@shared/compose-schema";
import { describe, expect, it } from "vitest";

// A miniature schema shaped like the real one: `patternProperties` under `services`,
// a `$ref` into `$defs`, an enum, and descriptions.
const SCHEMA = {
  properties: {
    services: { patternProperties: { "^[a-zA-Z0-9._-]+$": { $ref: "#/$defs/service" } } },
    volumes: { patternProperties: { ".+": { $ref: "#/$defs/volume" } } },
  },
  $defs: {
    service: {
      properties: {
        image: { type: "string", description: "The image to start the container from." },
        restart: { type: "string", enum: ["no", "always", "on-failure", "unless-stopped"] },
        ports: { type: "array", description: "Exposed ports." },
        deploy: { $ref: "#/$defs/deployment" },
      },
    },
    deployment: { properties: { replicas: { type: "integer", description: "How many." } } },
    volume: { properties: { driver: { type: "string" } } },
  },
};

describe("keysAt", () => {
  it("offers the top-level compose keys at the root", () => {
    expect(keysAt(SCHEMA, []).map((s) => s.label)).toEqual(
      expect.arrayContaining(["services", "volumes"]),
    );
  });

  it("offers service properties inside a named service", () => {
    // The service name is arbitrary, so this only works by matching patternProperties
    // rather than looking up a literal key.
    const labels = keysAt(SCHEMA, ["services", "web"]).map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(["image", "restart", "ports", "deploy"]));
  });

  it("follows a $ref to nested properties", () => {
    expect(keysAt(SCHEMA, ["services", "web", "deploy"]).map((s) => s.label)).toEqual(["replicas"]);
  });

  it("carries the description through as hover docs", () => {
    const image = keysAt(SCHEMA, ["services", "web"]).find((s) => s.label === "image");
    expect(image?.docs).toBe("The image to start the container from.");
  });

  it("returns nothing for a path the schema does not describe", () => {
    expect(keysAt(SCHEMA, ["services", "web", "nonsense"])).toEqual([]);
  });

  it("does not loop forever on a self-referential $ref", () => {
    // A malformed or unusually recursive schema must not hang the editor. Compose's real
    // schema has recursive definitions.
    const cyclic = { properties: { a: { $ref: "#/$defs/a" } }, $defs: { a: { $ref: "#/$defs/a" } } };
    expect(() => keysAt(cyclic, ["a"])).not.toThrow();
  });
});

describe("enumsAt", () => {
  it("offers a key's enum values", () => {
    expect(enumsAt(SCHEMA, ["services", "web", "restart"]).map((s) => s.label)).toEqual([
      "no", "always", "on-failure", "unless-stopped",
    ]);
  });

  it("returns nothing where there is no enum", () => {
    expect(enumsAt(SCHEMA, ["services", "web", "image"])).toEqual([]);
  });
});

describe("isKnownPath", () => {
  it("accepts a real path", () => {
    expect(isKnownPath(SCHEMA, ["services", "web", "image"])).toBe(true);
  });

  it("rejects a typo, which is what the unknown-key warning is for", () => {
    expect(isKnownPath(SCHEMA, ["services", "web", "imag"])).toBe(false);
  });

  it("accepts any service name, since those are user-chosen", () => {
    expect(isKnownPath(SCHEMA, ["services", "anything-at-all"])).toBe(true);
  });

  it("does not crash on a garbage schema", () => {
    for (const bad of [null, undefined, 42, "x", []]) {
      expect(() => isKnownPath(bad, ["services"])).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/shared/compose-schema.test.ts`
Expected: FAIL — cannot resolve `@shared/compose-schema`.

- [ ] **Step 3: Implement**

`src/shared/compose-schema.ts`:

```ts
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
```

- [ ] **Step 4: Run and verify**

Run: `pnpm exec vitest run src/shared/compose-schema.test.ts`
Expected: all pass.

- [ ] **Step 5: Verify against the real schema, not just the fixture**

Add one test importing the vendored `compose-spec.json` and asserting `keysAt(real, ["services", "web"])` contains `image`, `ports`, `environment` and `depends_on`, and that `enumsAt(real, ["services","web","restart"])` is non-empty. A walk that only works on a hand-made fixture is worth very little.

- [ ] **Step 6: Binding checks**

- Delete the `patternProperties` branch → the service-properties test and the real-schema test must both fail.
- Delete the `seen` guard → the cyclic test must fail (hang or throw).

- [ ] **Step 7: Commit**

```bash
git add src/shared/compose-schema.ts src/shared/compose-schema.test.ts
git commit -m "Walk the compose schema for completions, instead of shipping a validator"
```

---

### Task 4: The CodeMirror editor component

**This is the task that adds the dependencies.** `codemirror@6.0.2`, `@codemirror/lang-yaml@6.1.3`, `yaml@2.9.1`, and nothing else.

**Files:**
- Modify: `package.json`
- Create: `src/web/editor/YamlEditor.tsx`
- Test: `src/web/editor/YamlEditor.test.tsx`

**Interfaces:**
- Produces:
  ```tsx
  <YamlEditor
    value={string}
    onChange={(next: string) => void}
    diagnostics={EditorDiagnostic[]}
    extraExtensions={Extension[]}
    readOnly?={boolean}
  />
  export type EditorDiagnostic = { from: number; to: number; severity: "error" | "warning"; message: string };
  ```

- [ ] **Step 1: Install**

```bash
pnpm add codemirror@6.0.2 @codemirror/lang-yaml@6.1.3 yaml@2.9.1
```

Then `pnpm build` and record the bundle size change in your report. The spec chose CodeMirror over Monaco on size grounds; if the delta is wildly larger than "an order of magnitude smaller than Monaco" would suggest, say so.

- [ ] **Step 2: Write the failing test**

`src/web/editor/YamlEditor.test.tsx` — first line `// @vitest-environment jsdom`. Cover: renders a `.cm-editor`; shows the initial value; calls `onChange` when the document changes; **does not fire `onChange` when the `value` prop changes from outside** (that would loop); replaces the document when `value` changes externally without losing the cursor if the text is identical; renders a diagnostic; is read-only when asked.

The last two are the ones worth care. A controlled CodeMirror that dispatches its own value back on every external update is the classic bug in this integration, and it shows up as the cursor jumping to position 0 while typing.

- [ ] **Step 3: Run to verify it fails, then implement**

`src/web/editor/YamlEditor.tsx`. Create the `EditorView` once in a `useEffect` keyed on nothing, destroy it in the cleanup. Feed external `value` changes in through a `dispatch` **guarded by a comparison against the current document**, so an echo of our own change is a no-op rather than a loop. Feed `diagnostics` through `setDiagnostics` from `@codemirror/lint`. Keep `onChange` in a ref so the update listener does not need re-creating.

CodeMirror in jsdom needs no special setup, but layout measurements are all zero — do not write a test that depends on rendered geometry.

- [ ] **Step 4: Run, verify, binding-check**

- Remove the "document already matches" guard on external updates → the no-echo test must fail.
- Remove `view.destroy()` from the cleanup → assert on a leaked DOM node or listener and confirm it fails.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/web/editor/YamlEditor.tsx src/web/editor/YamlEditor.test.tsx
git commit -m "Add a YAML editor, controlled without fighting its own updates"
```

---

### Task 5: Lint layer one — parse the YAML

**Files:**
- Create: `src/web/editor/yaml-lint.ts`
- Test: `src/web/editor/yaml-lint.test.ts`

**Interfaces:**
- Consumes: `yaml`; `EditorDiagnostic` from Task 4; `isKnownPath` from Task 3.
- Produces: `export function lintYaml(text: string, schema: unknown): EditorDiagnostic[];`

- [ ] **Step 1: Write the failing test**

Cover: valid YAML yields no diagnostics; a syntax error yields one with a position inside the offending line; a tab-indented document — a common paste artefact that YAML rejects outright — reports something legible; an unknown key under a service yields a **warning**, not an error, since the schema may lag compose; a known key yields none; an empty document yields none rather than an error about nothing; a document that is valid YAML but not a mapping (a bare list) yields a legible message rather than a crash.

```ts
it("warns on an unknown service key rather than erroring", () => {
  // A warning, deliberately: the vendored schema is pinned, so a key added upstream is
  // unknown here and would otherwise look like a mistake the user made.
  const out = lintYaml("services:\n  web:\n    imag: nginx\n", SCHEMA);
  expect(out).toHaveLength(1);
  expect(out[0]?.severity).toBe("warning");
  expect(out[0]?.message).toContain("imag");
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Use `parseDocument` from `yaml` rather than `parse` — it returns errors with offsets instead of throwing, which is what a live editor needs. Map each error's `pos` to `from`/`to`. Then walk the document's mappings and, for each leaf path, call `isKnownPath`; where it is false, emit a warning at that key's range.

Only walk into paths the schema knows. A typo in a service name is not an unknown key — service names are arbitrary — and the `patternProperties` branch in Task 3 already handles that.

- [ ] **Step 3: Binding checks**

- Return `[]` unconditionally → every test must fail.
- Emit `severity: "error"` for unknown keys → the warning test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/editor/yaml-lint.ts src/web/editor/yaml-lint.test.ts
git commit -m "Report YAML syntax errors and unknown keys as you type"
```

---

### Task 6: Schema completions

**Files:**
- Create: `src/web/editor/schema-completion.ts`
- Test: `src/web/editor/schema-completion.test.ts`

**Interfaces:**
- Consumes: `keysAt`, `enumsAt` from Task 3; `@codemirror/autocomplete`'s `CompletionSource`.
- Produces: `export function schemaCompletion(schema: unknown): CompletionSource;` and, exported for testing, `export function pathAt(text: string, pos: number): string[];`

- [ ] **Step 1: Write the failing test for `pathAt`**

This is the part worth testing hard, because it is where the bugs live and it is pure.

```ts
describe("pathAt", () => {
  const DOC = ["services:", "  web:", "    image: nginx", "    deploy:", "      replicas: 2", ""].join("\n");

  it("is empty at the top level", () => {
    expect(pathAt("", 0)).toEqual([]);
  });

  it("reads the path from indentation", () => {
    // Cursor on the `image:` line.
    expect(pathAt(DOC, DOC.indexOf("image"))).toEqual(["services", "web"]);
  });

  it("descends into a nested mapping", () => {
    expect(pathAt(DOC, DOC.indexOf("replicas"))).toEqual(["services", "web", "deploy"]);
  });

  it("ignores blank lines and comments when computing the parent", () => {
    const doc = "services:\n  web:\n\n    # a note\n    image: nginx\n";
    expect(pathAt(doc, doc.indexOf("image"))).toEqual(["services", "web"]);
  });

  it("does not walk off the top on a leading-indented first line", () => {
    expect(() => pathAt("    image: nginx\n", 6)).not.toThrow();
  });
});
```

Then the completion source itself: at a key position it offers `keysAt`; after `restart: ` it offers `enumsAt`; it offers nothing inside a comment or a quoted string; each completion carries its schema `description` as the info text.

- [ ] **Step 2: Run to verify it fails, then implement**

`pathAt` walks backwards from the cursor's line, tracking decreasing indentation and collecting each parent's key. Skip blank and comment-only lines. Treat a line whose trimmed text starts with `- ` as a sequence item and do not add it as a path segment — a list entry is not a key.

The `CompletionSource` decides between key and value position by whether the text before the cursor on that line contains a `:` — before it, keys; after, enums for the key named to its left.

- [ ] **Step 3: Binding checks**

- Return `keysAt` regardless of position → the "offers enums after a colon" test must fail.
- Stop skipping comment lines in `pathAt` → the comment test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/editor/schema-completion.ts src/web/editor/schema-completion.test.ts
git commit -m "Complete compose keys and enum values from the vendored schema"
```

---

### Task 7: Document and `.env` completions

The spec's other two live sources: service names for `depends_on`, declared volumes and networks where referenced, and `.env` keys on `${`.

**Files:**
- Create: `src/web/editor/document-completion.ts`, `src/web/editor/env-completion.ts`
- Test: one test file each

**Interfaces:**
- Produces:
  ```ts
  export function documentCompletion(): CompletionSource;
  export function envCompletion(keys: () => string[]): CompletionSource;
  /** Exported for testing. */
  export function declaredNames(text: string): { services: string[]; volumes: string[]; networks: string[] };
  ```

- [ ] **Step 1: Write the failing tests**

For `declaredNames`: extracts service, volume and network names from a document; returns empty lists for a document with none; ignores a `services:` key nested inside a service (a `depends_on` list is not a service declaration); tolerates a syntactically broken document, because this runs on every keystroke and the document is broken most of the time while someone types.

That last one is the important one:

```ts
it("still finds what it can in a half-typed document", () => {
  // This runs while the user is mid-keystroke, so the document is invalid far more often
  // than it is valid. A parser that throws here means completions vanish exactly when
  // someone is typing, which is the only time they are wanted.
  const broken = "services:\n  web:\n    image: nginx\n  db\n";
  expect(() => declaredNames(broken)).not.toThrow();
  expect(declaredNames(broken).services).toContain("web");
});
```

For `documentCompletion`: inside a `depends_on` list it offers the other service names and **not** the service you are inside; under `volumes:` on a service it offers declared top-level volumes; it offers nothing elsewhere.

For `envCompletion`: after `${` it offers the supplied keys; it offers nothing without the `${`; a key not in the list is flagged — surface that as a completion `detail` reading "not defined in .env", so a user typing a variable that does not exist can see it.

- [ ] **Step 2: Run to verify they fail, then implement**

Prefer a line-based scan over a full parse for `declaredNames`, precisely so a broken document still yields something. A `yaml` parse that throws leaves the user with no completions at the moment they most need them.

- [ ] **Step 3: Binding checks**

- Include the current service in `depends_on` completions → its test must fail.
- Make `declaredNames` use `parse` and throw → the broken-document test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/editor/document-completion.ts src/web/editor/env-completion.ts src/web/editor/*.test.ts
git commit -m "Complete service names and .env variables from the buffer beside you"
```

---

### Task 8: Desktop-only completions

Spec §8: *"Autocomplete, desktop only (gated behind `(pointer: fine)` and a width check; on touch, completion popups fight the virtual keyboard)."*

**Files:**
- Create: `src/web/editor/desktop-only.ts`
- Test: `src/web/editor/desktop-only.test.ts`

**Interfaces:**
- Produces: `export function completionsEnabled(win: Pick<Window, "matchMedia" | "innerWidth">): boolean;`

- [ ] **Step 1: Write the failing test**

Cover: fine pointer plus a wide window → true; coarse pointer → false even when wide; fine pointer but narrow → false; **`matchMedia` missing entirely → false**, because an environment that cannot answer the question is not one to show a popup in; `matchMedia` throwing → false rather than propagating.

Inject the window rather than stubbing a global — it makes every case a plain function call.

- [ ] **Step 2: Run to verify it fails, then implement**

```ts
/** Below this, a completion popup covers the line you are editing. */
const MIN_WIDTH = 768;

export function completionsEnabled(win: Pick<Window, "matchMedia" | "innerWidth">): boolean {
  try {
    if (typeof win.matchMedia !== "function") return false;
    if (!win.matchMedia("(pointer: fine)").matches) return false;
    return win.innerWidth >= MIN_WIDTH;
  } catch {
    // An environment that cannot answer is not one to show a popup in.
    return false;
  }
}
```

- [ ] **Step 3: Binding check**

Return `true` when `matchMedia` is absent → its test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/editor/desktop-only.ts src/web/editor/desktop-only.test.ts
git commit -m "Keep completion popups off touch keyboards"
```

---

### Task 9: Lint layer two — the debounced server round trip

Spec §8: *"a debounced server round-trip to `docker compose config` for semantics. The schema cannot know that `depends_on: [databse]` references an undefined service or that `.env` is missing a variable; only resolution can."*

**Files:**
- Create: `src/web/editor/use-server-validate.ts`
- Test: `src/web/editor/use-server-validate.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`; `POST /api/apps/:id/compose/validate` returning `{ valid: true } | { valid: false; message: string }`.
- Produces: `export function useServerValidate(appId: string, text: string): { checking: boolean; message: string | null };`

- [ ] **Step 1: Write the failing test**

Cover: does not fire on mount before the debounce elapses; fires once for a burst of edits, not once per keystroke; **a stale response never overwrites a newer one** — the classic bug here, where a slow validation of two-edits-ago replaces the result for what is on screen now; reports the server's message; a network failure does not clear a previous valid state into a false error; the timer is cleared on unmount.

```tsx
it("ignores a response that arrives after a newer request went out", async () => {
  // Each keystroke restarts the debounce, but a slow round trip can still land after the
  // next one has been sent. Showing its verdict means the user sees an error about text
  // they already fixed.
  ...
});
```

Each new `.tsx` test file adds one row to `src/web/test-environment.test.ts`'s sweep.

- [ ] **Step 2: Run to verify it fails, then implement**

Debounce at **600 ms** — long enough that a sentence of typing is one request, short enough to feel connected. Every request carries a monotonically increasing sequence number; a response whose sequence is not the latest is discarded. Clear the timer and mark the in-flight sequence stale on unmount.

Note `POST /compose/validate` writes a temp file and shells out to `docker compose config`, so it is not free — the debounce is protecting the NAS, not just the network.

- [ ] **Step 3: Binding checks**

- Remove the sequence check → the stale-response test must fail.
- Remove the debounce → the one-request-per-burst test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/editor/use-server-validate.ts src/web/editor/use-server-validate.test.tsx
git commit -m "Ask the server what the schema cannot know, once you stop typing"
```

---

### Task 10: The Compose tab

**Files:**
- Create: `src/web/routes/edit/ComposeTab.tsx`
- Modify: `src/web/api/admin.ts` (a compose hook)
- Test: `src/web/routes/edit/ComposeTab.test.tsx`

**Interfaces:**
- Consumes: everything above; `{ app: AdminApp }` from `useOutletContext`; `GET/PUT /api/apps/:id/compose`.
- Produces: `<ComposeTab />` at `/apps/:slug/compose`.

- [ ] **Step 1: Write the failing test**

Cover: loads and shows the file; typing marks it dirty and enables Save; Save sends the content **with the hash it loaded**; a successful save clears dirty and adopts the new hash, so a second save works without reloading; a **409 hash mismatch** is reported as someone else having changed the file, with a way to reload that does not silently discard the user's text; navigating away with unsaved changes warns; the read-only case — an unreadable file — says so rather than showing an empty editor; completions are absent on a narrow viewport.

The 409 is the one that matters most, and the reason the hash guard exists:

```tsx
it("does not silently discard your edits when the file changed underneath you", async () => {
  // The hash guard's whole purpose. Overwriting an SSH edit is unrecoverable, and so is
  // throwing away what the user just typed — so offer both texts, do neither.
  ...
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Compose the extensions: `yaml()` from `@codemirror/lang-yaml`, the lint layer from Task 5, and — **only when `completionsEnabled(window)`** — the three completion sources. Pass the server-validate message through as a separate banner rather than as an editor diagnostic; it has no position.

Fetch the `.env` keys for `envCompletion` from the masked endpoint, which returns keys without values. Do **not** call reveal for completions — completing a name needs the key, never the secret.

- [ ] **Step 3: Binding checks**

- Send `expectedHash: null` on save → the hash test must fail.
- Reload on 409 without offering the user's text → the discard test must fail.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/edit/ComposeTab.tsx src/web/routes/edit/ComposeTab.test.tsx src/web/api/admin.ts
git commit -m "Edit compose.yaml, with help and without clobbering an SSH edit"
```

---

### Task 11: The `.env` tab

Spec §8: *"a masked key/value table with reveal-per-row (audit-logged) plus a raw mode for bulk paste."*

**Files:**
- Create: `src/web/routes/edit/EnvTab.tsx`
- Modify: `src/web/api/admin.ts` (env hooks)
- Test: `src/web/routes/edit/EnvTab.test.tsx`

**Interfaces:**
- Consumes: `GET /api/apps/:id/env`, `POST /api/apps/:id/env/reveal` with and without a key (Task 2), `PUT /api/apps/:id/env`.
- Produces: `<EnvTab />` at `/apps/:slug/env`.

- [ ] **Step 1: Write the failing test**

Cover: lists each key with a fixed-width mask and **never the value** until revealed; revealing one row calls reveal with that key and shows only that value; revealing one row does not reveal another; editing a value and saving sends a file with the other entries and their comments intact; raw mode fetches the whole file and edits text; switching from raw back to table after an edit does not silently drop the raw edit; a `409 env_unreadable` says the file exists but cannot be read; the tab requires `app:secrets` and a plain admin without it sees a clear refusal rather than an empty table.

The comment-preservation test is the one that protects real data:

```tsx
it("keeps the comments on the lines it did not touch", async () => {
  // `upsertEnv` exists because editing one variable used to destroy the note explaining
  // why another was set — a loss the user only discovers later, over SSH.
  ...
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

The table edits **entries**, not text. Load the masked list; on save, fetch the current full content, apply each changed key with `upsertEnv`, and `PUT` the serialised result with the hash from that fetch. That keeps every untouched line byte-identical.

Mask with the same fixed-width `••••••••` the server uses, so the mask reveals nothing about a secret's length.

Raw mode uses whole-file reveal and `PUT`s the text directly.

- [ ] **Step 3: Binding checks**

- Rebuild the file from key-value pairs instead of `upsertEnv` → the comment test must fail.
- Reveal without a key and filter client-side → the "does not reveal another" test must fail if it asserts on the request rather than the DOM; make sure it does.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/edit/EnvTab.tsx src/web/routes/edit/EnvTab.test.tsx src/web/api/admin.ts
git commit -m "Edit .env one masked row at a time, without losing the comments"
```

---

### Task 12: Route the tabs, and check the whole surface

**Files:**
- Modify: `src/web/App.tsx`, `src/web/routes/EditApp.tsx`
- Test: `src/web/routes/EditApp.test.tsx` (extend), `src/web/App.test.tsx` (extend)

- [ ] **Step 1: Write the failing tests**

Cover: the edit page offers Compose and Env tab links; each route renders its tab and **only** its tab — the data-loading boundary rule from 1E, which matters more here than anywhere because the compose tab mounts a whole editor; a viewer redirected away from `/apps/:slug/compose` and `/apps/:slug/env`; and the tab list is still in a sensible order.

- [ ] **Step 2: Implement, run, verify**

Add the two routes beside `overview`, `containers`, `logs` and `probes`. 1E's Task 6 built the tab list to be extended rather than hard-coded three; if it was not, make it so now rather than adding two more literals.

- [ ] **Step 3: Full gates**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run     # three times
pnpm exec biome check . > /tmp/biome.out 2>&1; echo "exit: $?"
pnpm build
```

Record the built bundle size in your report and compare it to before this phase. CodeMirror is the largest thing this project has ever shipped to a browser and the spec chose it on size grounds; the number should be written down once.

- [ ] **Step 4: Commit**

```bash
git add src/web/App.tsx src/web/routes/EditApp.tsx src/web/routes/EditApp.test.tsx src/web/App.test.tsx
git commit -m "Route the compose and env tabs, and keep viewers out of both"
```

---

## Self-Review

**1. Spec coverage.** Every requirement in §8's "Compose editor" subsection maps to a task:

| Spec requirement | Task |
|---|---|
| CodeMirror 6 with `@codemirror/lang-yaml` | 4 |
| Autocomplete desktop-only, `(pointer: fine)` + width | 8, 10 |
| Completion source: compose JSON Schema, keys + enums + hover docs | 3, 6 |
| Completion source: current document (`depends_on`, volumes, networks) | 7 |
| Completion source: sibling `.env` on `${`, flagging undefined | 7 |
| Completion source: registry tags | **Deferred by the spec itself** |
| Schema vendored at a pinned commit, not fetched at runtime | 1 |
| Lint layer one: client YAML parse + schema | 5 |
| Lint layer two: debounced `docker compose config` | 9 |
| `.env` masked key/value table | 11 |
| `.env` reveal per row, audit-logged | 2, 11 |
| `.env` raw mode for bulk paste | 11 |

**Deliberately out of scope, recorded rather than dropped:** registry tag completion, which the spec marks deferred and calls rate-limit sensitive.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Tasks 4, 7, 10 and 11 give test *coverage lists* with the load-bearing cases written out in full rather than every body verbatim — deliberate, and the cases that carry each task are quoted with their reasoning. Tasks 1, 3, 6 and 8 carry complete code, because they are the pure logic everything else rests on.

**3. Type consistency.** `SchemaSuggestion` is produced by Task 3 and consumed by Task 6. `EditorDiagnostic` is defined in Task 4 and consumed by Task 5. `CompletionSource` comes from `@codemirror/autocomplete`, which arrives with `codemirror` in Task 4 — **Tasks 6, 7 and 8 therefore cannot be started before Task 4**, even though 3 and 8 are otherwise pure. `completionsEnabled` takes an injected window in Task 8 and is called with the real one in Task 10. `pathAt` and `declaredNames` are exported for testing only.

**4. Cross-task conflict scan.**

| Tasks | Shared surface | Finding |
|---|---|---|
| 3, 5, 6 | the vendored schema | 1 produces it, 3 walks it, 5 and 6 consume the walk. Strictly ordered. |
| 4 → 6, 7, 8 | `@codemirror/autocomplete` | Only available after Task 4 installs it. **Ordering constraint, stated above.** |
| 2, 11 | reveal endpoint | 2 adds the per-key mode, 11 consumes it. 11 must not fall back to whole-file for the table. |
| 10, 11, 12 | `src/web/api/admin.ts` | 10 and 11 each append hooks; 12 touches neither. Sequential. |
| 10, 12 | `App.tsx` routes | 12 owns both route additions; 10 and 11 build components only. |
| 5, 9 | the word "lint" | Two layers, two mechanisms — 5 produces positioned diagnostics for the editor gutter, 9 produces one unpositioned message for a banner. Do not merge them; the spec's argument is that each covers what the other cannot. |

**5. Risks worth naming.**

- **Task 1 needs the network.** Nothing else in this plan does. If it is unavailable the phase stalls at the first task, and inventing a schema by hand would be worse than waiting.
- **This phase changes the browser bundle materially.** `pnpm build` is a gate in Tasks 4 and 12 for that reason, and the size is recorded twice so the delta is attributable.
- **`pathAt` is indentation-based, not parser-based.** That is deliberate — it must work on a document that is invalid most of the time someone is typing — but it means tabs, unusual indentation and flow-style mappings (`{a: 1}`) will defeat it. Flow style in a compose file is rare; if a reviewer finds it common, that is a real finding.
