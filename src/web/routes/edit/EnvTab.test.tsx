// @vitest-environment jsdom

import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { envKey } from "@web/api/admin";
import type { EditAppContext } from "@web/routes/EditApp";
import { EnvTab, nextRawState } from "@web/routes/edit/EnvTab";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const app: AdminApp = {
  id: "a1",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: "Media server",
  iconRef: null,
  category: "Media",
  launchUrl: null,
  status: "up",
  statusDetail: null,
  hostId: "local",
  directory: "jellyfin",
  composeFile: "compose.yaml",
  projectName: "jellyfin",
  lastComposeHash: null,
  isSystem: false,
  showOnLauncher: true,
  sortOrder: 0,
  graceUntil: null,
  adoptedAt: 1_800_000_000,
  archivedAt: null,
  lastDeployAt: null,
};

const MASK = "••••••••";

/** The file `withEnv`'s real-world counterpart in `apps-env.test.ts` also starts from:
 * a full-line comment, an inline comment on the second variable. Both must survive a
 * table-mode edit to the first variable untouched. */
const FILE_CONTENT = "# Database\nDB_PASSWORD=hunter2\nPUID=1000 # keep this note\n";
const FILE_HASH = "h1";

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/apps/jellyfin/env"]}>
          <Routes>
            <Route
              path="/apps/:slug/*"
              element={<Outlet context={{ app } satisfies EditAppContext} />}
            >
              <Route path="env" element={<EnvTab />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * One fetch double routing every URL this tab can call, matching `ComposeTab.test.tsx`'s
 * shape. `reveal` is a function rather than a canned body because the same endpoint
 * answers two different requests here — with a `key` (one row) and without one (the
 * whole file, for raw mode and for save) — and a test needs to tell them apart from the
 * request itself, not just decide what the DOM should show.
 */
function mockApi(
  opts: {
    env?: { status: number; body: unknown };
    reveal?: (key: string | undefined) => { status: number; body: unknown };
    put?: Array<{ status: number; body: unknown }>;
  } = {},
) {
  const putResponses = opts.put ?? [{ status: 200, body: { hash: "h2" } }];
  let putCalls = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/env/reveal") && method === "POST") {
        const body = init?.body ? (JSON.parse(init.body as string) as { key?: string }) : {};
        const r = opts.reveal
          ? opts.reveal(body.key)
          : { status: 200, body: { content: FILE_CONTENT, hash: FILE_HASH, exists: true } };
        return json(r.status, r.body);
      }
      if (url.endsWith("/env") && method === "GET") {
        const e = opts.env ?? { status: 200, body: { entries: [], exists: false } };
        return json(e.status, e.body);
      }
      if (url.endsWith("/env") && method === "PUT") {
        const r = putResponses[Math.min(putCalls, putResponses.length - 1)];
        putCalls++;
        return json(r?.status ?? 200, r?.body ?? { hash: "h2" });
      }
      return json(200, {});
    }),
  );
}

function revealCalls(): Array<{ key?: string }> {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => String(url).endsWith("/env/reveal"))
    .map(([, init]) => (init?.body ? JSON.parse(init.body as string) : {}));
}

function puts(): RequestInit[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => init as RequestInit);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("nextRawState", () => {
  // Binds the guard the DOM cannot: `rawText` is only ever rendered while `rawLoaded`
  // is true, and a pure table save never sets `rawLoaded`, so a component-level test
  // that mutates this guard away sees no visible difference at all — the entire
  // pre-existing suite stayed green when the review tried exactly that. Testing the
  // extracted decision directly is what makes "no" an assertable answer.
  it("does not resume tracking the raw file after a save that pure table edits produced", () => {
    // This is the dangerous case: a table-only save fetched the whole file (every
    // secret in it) to run `upsertEnv` against, and — if this returned non-null here —
    // that content would be parked in `rawText` for the rest of the tab's life despite
    // raw mode never having been opened.
    expect(nextRawState(false, { content: "DB_PASSWORD=hunter2\n", hash: "h9" })).toBeNull();
  });

  it("keeps tracking the raw file when raw mode is what produced the save", () => {
    expect(nextRawState(true, { content: "DB_PASSWORD=hunter2\n", hash: "h9" })).toEqual({
      rawText: "DB_PASSWORD=hunter2\n",
      rawBaseline: "DB_PASSWORD=hunter2\n",
      rawHash: "h9",
    });
  });
});

describe("EnvTab", () => {
  it("lists each key with a fixed-width mask and never fetches a value on its own", async () => {
    mockApi({
      env: {
        status: 200,
        body: {
          entries: [
            { key: "DB_PASSWORD", masked: MASK },
            { key: "PUID", masked: MASK },
          ],
          exists: true,
        },
      },
    });
    mount();

    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());
    expect(screen.getByText("PUID")).toBeTruthy();
    expect(screen.getAllByDisplayValue(MASK)).toHaveLength(2);
    // Nothing about either secret's value is on screen, and nothing was fetched to find
    // out — the table's own load never calls reveal.
    expect(screen.queryByText("hunter2")).toBeNull();
    expect(revealCalls()).toHaveLength(0);
  });

  it("revealing one row calls reveal with that key and shows only that value", async () => {
    mockApi({
      env: {
        status: 200,
        body: {
          entries: [
            { key: "DB_PASSWORD", masked: MASK },
            { key: "PUID", masked: MASK },
          ],
          exists: true,
        },
      },
      reveal: (key) => {
        const values: Record<string, string> = { DB_PASSWORD: "hunter2", PUID: "1000" };
        return { status: 200, body: { key, value: key ? values[key] : "" } };
      },
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: "Reveal" })[0] as HTMLElement);

    await waitFor(() => expect(screen.getByDisplayValue("hunter2")).toBeTruthy());
    // The other row is untouched: still masked, not fetched.
    expect(screen.getAllByDisplayValue(MASK)).toHaveLength(1);
  });

  it("does not reveal another row — asserted on the request, not just the DOM", async () => {
    // The binding check this guards against: fetching the whole file once and filtering
    // which row to show client-side would make the DOM assertion above pass too, while
    // shipping every secret to the browser to display one. Only the request proves which
    // implementation actually ran.
    mockApi({
      env: {
        status: 200,
        body: {
          entries: [
            { key: "DB_PASSWORD", masked: MASK },
            { key: "PUID", masked: MASK },
          ],
          exists: true,
        },
      },
      reveal: (key) => {
        const values: Record<string, string> = { DB_PASSWORD: "hunter2", PUID: "1000" };
        return { status: 200, body: { key, value: key ? values[key] : "" } };
      },
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: "Reveal" })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByDisplayValue("hunter2")).toBeTruthy());

    const calls = revealCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ key: "DB_PASSWORD" });
  });

  it("keeps the comments on the lines it did not touch", async () => {
    // `upsertEnv` exists because editing one variable used to destroy the note explaining
    // why another was set — a loss the user only discovers later, over SSH. Rebuilding
    // the file from key/value pairs (the binding check for this test) would drop both
    // the leading "# Database" comment line and PUID's inline "# keep this note".
    mockApi({
      env: {
        status: 200,
        body: {
          entries: [
            { key: "DB_PASSWORD", masked: MASK },
            { key: "PUID", masked: MASK },
          ],
          exists: true,
        },
      },
      reveal: (key) =>
        key
          ? { status: 200, body: { key, value: "hunter2" } }
          : { status: 200, body: { content: FILE_CONTENT, hash: FILE_HASH, exists: true } },
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: "Reveal" })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByDisplayValue("hunter2")).toBeTruthy());

    fireEvent.change(screen.getByDisplayValue("hunter2"), { target: { value: "newpass" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(puts()[0]?.body as string);
    expect(body).toEqual({
      content: "# Database\nDB_PASSWORD=newpass\nPUID=1000 # keep this note\n",
      expectedHash: FILE_HASH,
    });
  });

  it("raw mode fetches the whole file and edits text directly", async () => {
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: () => ({
        status: 200,
        body: { content: FILE_CONTENT, hash: FILE_HASH, exists: true },
      }),
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    await waitFor(() => expect(screen.getByLabelText(".env file contents")).toBeTruthy());
    expect((screen.getByLabelText(".env file contents") as HTMLTextAreaElement).value).toBe(
      FILE_CONTENT,
    );
    // Raw mode's own reveal is the "deliberate reveal" the audit's `reason` exists to
    // distinguish from a save's merge fetch — see the `reason` findings in apps.ts /
    // EnvTab.tsx.
    expect(revealCalls()).toEqual([{ reason: "raw-edit" }]);

    fireEvent.change(screen.getByLabelText(".env file contents"), {
      target: { value: `${FILE_CONTENT}NEW_KEY=added\n` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(puts()[0]?.body as string);
    expect(body).toEqual({ content: `${FILE_CONTENT}NEW_KEY=added\n`, expectedHash: FILE_HASH });
  });

  it("does not silently drop a raw edit when switching back to the table view before saving", async () => {
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: () => ({
        status: 200,
        body: { content: FILE_CONTENT, hash: FILE_HASH, exists: true },
      }),
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    await waitFor(() => expect(screen.getByLabelText(".env file contents")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(".env file contents"), {
      target: { value: `${FILE_CONTENT}NEW_KEY=added\n` },
    });

    // Back to the table — the raw edit is still sitting in this tab's own state, not on
    // disk and not re-fetched from it.
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(puts()[0]?.body as string);
    expect(body).toEqual({ content: `${FILE_CONTENT}NEW_KEY=added\n`, expectedHash: FILE_HASH });
  });

  it("shows a raw edit's new key in the table immediately, before saving", async () => {
    // The table used to keep showing whatever `GET .../env` returned at load, unaffected
    // by anything typed in raw mode — correct once saved (see the "does not silently
    // drop" test above), but a key added or changed in raw mode simply didn't appear in
    // the table until then, even though the state already carried it.
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: () => ({
        status: 200,
        body: { content: FILE_CONTENT, hash: FILE_HASH, exists: true },
      }),
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    await waitFor(() => expect(screen.getByLabelText(".env file contents")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(".env file contents"), {
      target: { value: `${FILE_CONTENT}NEW_KEY=added\n` },
    });

    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    await waitFor(() => expect(screen.getByText("NEW_KEY")).toBeTruthy());
    // Still masked — reflecting a raw edit in the table does not hand it a secret value
    // the user has not explicitly revealed for that row.
    expect(screen.getAllByDisplayValue(MASK).length).toBeGreaterThan(0);
    expect(screen.queryByText("added")).toBeNull();
  });

  it("merges a table edit onto the disk's newer content on a stale hash, without asking", async () => {
    // `upsertEnv` only ever changes the keys this tab actually touched, so a 409 here
    // does not need the user to adjudicate anything — refetching and reapplying the same
    // edit preserves both the user's change and whatever showed up on disk meanwhile,
    // the same guarantee a single save already gives untouched lines.
    const diskV1 = "DB_PASSWORD=hunter2\n";
    const diskV2 = "DB_PASSWORD=hunter2\nEXTRA=fromssh\n";
    let wholeCalls = 0;
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: (key) => {
        if (key) return { status: 200, body: { key, value: "hunter2" } };
        wholeCalls++;
        return wholeCalls === 1
          ? { status: 200, body: { content: diskV1, hash: "h1", exists: true } }
          : { status: 200, body: { content: diskV2, hash: "h2", exists: true } };
      },
      put: [
        { status: 409, body: { error: "stale_hash", message: "Changed on disk." } },
        { status: 200, body: { hash: "h3" } },
      ],
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => expect(screen.getByDisplayValue("hunter2")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("hunter2"), { target: { value: "newpass" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts()).toHaveLength(2));
    const secondBody = JSON.parse(puts()[1]?.body as string);
    expect(secondBody).toEqual({
      content: "DB_PASSWORD=newpass\nEXTRA=fromssh\n",
      expectedHash: "h2",
    });
    // No conflict to adjudicate — the merge resolved it on its own.
    expect(screen.queryByText(/Someone changed this file since you loaded it/)).toBeNull();
  });

  it("does not silently discard a raw edit when the file changed underneath you", async () => {
    // A raw edit is arbitrary free-form text, not a set of named key changes, so it
    // cannot be merged the way a table edit can — this needs the same explicit,
    // two-choice conflict `ComposeTab` uses for its own whole-file edits.
    const diskContent = "DB_PASSWORD=hunter2\nEXTRA=fromssh\n";
    let wholeCalls = 0;
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: () => {
        wholeCalls++;
        return wholeCalls === 1
          ? { status: 200, body: { content: FILE_CONTENT, hash: FILE_HASH, exists: true } }
          : { status: 200, body: { content: diskContent, hash: "h2", exists: true } };
      },
      put: [{ status: 409, body: { error: "stale_hash", message: "Changed on disk." } }],
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    await waitFor(() => expect(screen.getByLabelText(".env file contents")).toBeTruthy());
    const myText = `${FILE_CONTENT}NEW_KEY=added\n`;
    fireEvent.change(screen.getByLabelText(".env file contents"), { target: { value: myText } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Someone changed this file since you loaded it/);

    // The user's text is untouched — not reverted, not overwritten.
    expect((screen.getByLabelText(".env file contents") as HTMLTextAreaElement).value).toBe(myText);

    // Both texts are available: theirs is still right there, and the disk's current
    // version can be shown alongside it.
    fireEvent.click(screen.getByText("Show the version currently on disk"));
    await waitFor(() => expect(screen.getByText(/EXTRA=fromssh/)).toBeTruthy());

    const useDiskButton = screen.getByRole("button", { name: "Load the version on disk instead" });
    await waitFor(() => expect(useDiskButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(useDiskButton);
    // Clicking it does not immediately discard anything — it asks first.
    expect((screen.getByLabelText(".env file contents") as HTMLTextAreaElement).value).toBe(myText);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/replaces this tab's raw text/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Load it" }));
    await waitFor(() =>
      expect((screen.getByLabelText(".env file contents") as HTMLTextAreaElement).value).toBe(
        diskContent,
      ),
    );
    expect(screen.queryByText(/Someone changed this file since you loaded it/)).toBeNull();
  });

  it("offers an explicit overwrite for a raw edit that resends against the fresh hash", async () => {
    const diskContent = "DB_PASSWORD=hunter2\nEXTRA=fromssh\n";
    let wholeCalls = 0;
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: () => {
        wholeCalls++;
        return wholeCalls === 1
          ? { status: 200, body: { content: FILE_CONTENT, hash: FILE_HASH, exists: true } }
          : { status: 200, body: { content: diskContent, hash: "h2", exists: true } };
      },
      put: [
        { status: 409, body: { error: "stale_hash", message: "Changed on disk." } },
        { status: 200, body: { hash: "h3" } },
      ],
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    await waitFor(() => expect(screen.getByLabelText(".env file contents")).toBeTruthy());
    const myText = `${FILE_CONTENT}NEW_KEY=added\n`;
    fireEvent.change(screen.getByLabelText(".env file contents"), { target: { value: myText } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Someone changed this file since you loaded it/);

    const overwriteButton = screen.getByRole("button", {
      name: "Keep mine — overwrite the disk version",
    });
    await waitFor(() => expect(overwriteButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(overwriteButton);

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/saves your edits over what's currently on disk/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Overwrite" }));

    await waitFor(() => expect(puts()).toHaveLength(2));
    const secondBody = JSON.parse(puts()[1]?.body as string);
    expect(secondBody).toEqual({ content: myText, expectedHash: "h2" });

    await waitFor(() =>
      expect(screen.queryByText(/Someone changed this file since you loaded it/)).toBeNull(),
    );
  });

  it("does not silently reapply a pending delete once the disk version has been loaded", async () => {
    // Critical from the final review: `handleUseDiskVersion` used to leave `deletedKeys`
    // (and every other bit of pending table state) untouched. The confirm dialog promises
    // "what you've typed here will be gone" — but a pending delete surviving that reload
    // meant the NEXT save carried it out anyway, deleting a credential from the disk
    // content the user had just chosen to adopt.
    const base = "DB_PASSWORD=hunter2\nPUID=1000\n";
    const diskContent = "DB_PASSWORD=hunter2\nPUID=1000\nEXTRA=fromssh\n";
    let wholeCalls = 0;
    mockApi({
      env: {
        status: 200,
        body: {
          entries: [
            { key: "DB_PASSWORD", masked: MASK },
            { key: "PUID", masked: MASK },
          ],
          exists: true,
        },
      },
      reveal: () => {
        wholeCalls++;
        return wholeCalls === 1
          ? { status: 200, body: { content: base, hash: "h1", exists: true } }
          : { status: 200, body: { content: diskContent, hash: "h2", exists: true } };
      },
      put: [
        { status: 409, body: { error: "stale_hash", message: "Changed on disk." } },
        { status: 200, body: { hash: "h3" } },
      ],
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    const dbRow = screen.getByText("DB_PASSWORD").closest("tr");
    if (!dbRow) throw new Error("row not found");
    fireEvent.click(within(dbRow).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Will be removed on save.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Someone changed this file since you loaded it/);

    fireEvent.click(screen.getByText("Show the version currently on disk"));
    const useDiskButton = screen.getByRole("button", { name: "Load the version on disk instead" });
    await waitFor(() => expect(useDiskButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(useDiskButton);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Load it" }));

    // The pending delete is gone: DB_PASSWORD is back to a normal row.
    await waitFor(() => expect(screen.queryByText("Will be removed on save.")).toBeNull());
    // Nothing left pending — the save button reflects that directly.
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);

    // A fresh, unrelated edit should be the ONLY thing the next save carries.
    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "NEWKEY" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "y" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts()).toHaveLength(2));
    const body = JSON.parse(puts()[1]?.body as string);
    expect(body).toEqual({
      content: `${diskContent}NEWKEY=y\n`,
      expectedHash: "h2",
    });
  });

  it("does not silently reapply a stale value edit once the disk version has been loaded", async () => {
    const base = "DB_PASSWORD=hunter2\n";
    const fresh = "DB_PASSWORD=hunter2\nEXTRA=fromssh\n";
    const diskContent = "DB_PASSWORD=hunter2\nEXTRA=fromssh\nMORE=1\n";
    let wholeCalls = 0;
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: (key) => {
        if (key) return { status: 200, body: { key, value: "hunter2" } };
        wholeCalls++;
        if (wholeCalls === 1)
          return { status: 200, body: { content: base, hash: "h1", exists: true } };
        if (wholeCalls === 2)
          return { status: 200, body: { content: fresh, hash: "h2", exists: true } };
        return { status: 200, body: { content: diskContent, hash: "h3", exists: true } };
      },
      put: [
        { status: 409, body: { error: "stale_hash", message: "Changed on disk." } },
        { status: 409, body: { error: "stale_hash", message: "Changed on disk." } },
        { status: 200, body: { hash: "h4" } },
      ],
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => expect(screen.getByDisplayValue("hunter2")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("hunter2"), { target: { value: "newpass" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // The per-key merge's own retry also conflicts (a second concurrent write), which is
    // the fallback path that lands on the same whole-file conflict raw edits get.
    await screen.findByText(/Someone changed this file since you loaded it/);

    fireEvent.click(screen.getByText("Show the version currently on disk"));
    const useDiskButton = screen.getByRole("button", { name: "Load the version on disk instead" });
    await waitFor(() => expect(useDiskButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(useDiskButton);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Load it" }));

    // The stale edit is gone: the row shows the masked disk value again, not "newpass".
    await waitFor(() => expect(screen.queryByDisplayValue("newpass")).toBeNull());
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "NEWKEY" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "z" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts()).toHaveLength(3));
    const body = JSON.parse(puts()[2]?.body as string);
    expect(body).toEqual({
      content: `${diskContent}NEWKEY=z\n`,
      expectedHash: "h3",
    });
  });

  it("does not silently reapply a pending add once the disk version has been loaded", async () => {
    const base = "DB_PASSWORD=hunter2\n";
    const diskContent = "DB_PASSWORD=hunter2\nEXTRA=fromssh\n";
    let wholeCalls = 0;
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: () => {
        wholeCalls++;
        return wholeCalls === 1
          ? { status: 200, body: { content: base, hash: "h1", exists: true } }
          : { status: 200, body: { content: diskContent, hash: "h2", exists: true } };
      },
      put: [
        { status: 409, body: { error: "stale_hash", message: "Changed on disk." } },
        { status: 200, body: { hash: "h3" } },
      ],
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "NEWVAR" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "temp" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    expect(screen.getByText("NEWVAR")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Someone changed this file since you loaded it/);

    fireEvent.click(screen.getByText("Show the version currently on disk"));
    const useDiskButton = screen.getByRole("button", { name: "Load the version on disk instead" });
    await waitFor(() => expect(useDiskButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(useDiskButton);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Load it" }));

    // The pending add is gone: no more pending "NEWVAR" row.
    await waitFor(() => expect(screen.queryByText("NEWVAR")).toBeNull());
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "OTHERVAR" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts()).toHaveLength(2));
    const body = JSON.parse(puts()[1]?.body as string);
    expect(body).toEqual({
      content: `${diskContent}OTHERVAR=x\n`,
      expectedHash: "h2",
    });
    // The abandoned add never made it into the save that actually landed.
    expect(body.content).not.toContain("NEWVAR");
  });

  it("says the file exists but cannot be read, distinctly from having none", async () => {
    mockApi({
      env: {
        status: 409,
        body: {
          error: "env_unreadable",
          message: "A .env file exists but Homestead cannot read it. Check its ownership and mode.",
        },
      },
    });
    mount();

    await waitFor(() =>
      expect(screen.getByText(/A \.env file exists but Homestead cannot read it/)).toBeTruthy(),
    );
    expect(screen.queryByText(/no variables set/i)).toBeNull();
    expect(screen.queryByText(/no \.env file yet/i)).toBeNull();
  });

  it("requires app:secrets, and a 403 shows a clear refusal rather than an empty table", async () => {
    mockApi({
      env: {
        status: 403,
        body: { error: "ForbiddenError", message: "Missing capability: app:config" },
      },
    });
    mount();

    await waitFor(() => expect(screen.getByText(/app:secrets/)).toBeTruthy());
    expect(screen.queryByText(/no variables set/i)).toBeNull();
    expect(screen.queryByText(/no \.env file yet/i)).toBeNull();
  });

  it("marks the earlier of a duplicated key as shadowed, since reveal and save both use the later one", async () => {
    mockApi({
      env: {
        status: 200,
        body: {
          entries: [
            { key: "API_KEY", masked: MASK },
            { key: "API_KEY", masked: MASK },
          ],
          exists: true,
        },
      },
      reveal: (key) => ({ status: 200, body: { key, value: "live-value" } }),
    });
    mount();
    await waitFor(() => expect(screen.getAllByText("API_KEY")).toHaveLength(2));

    // Only the first (earlier) row is flagged — the second is the one that wins.
    expect(screen.getByText(/that later line is the one compose reads/i)).toBeTruthy();

    const revealButtons = screen.getAllByRole("button", { name: "Reveal" });
    expect(revealButtons).toHaveLength(2);
    fireEvent.click(revealButtons[0] as HTMLElement);
    fireEvent.click(revealButtons[1] as HTMLElement);

    // Both rows reveal the same value — the one compose actually reads — which is the
    // correct, if initially surprising, behaviour the shadow note explains.
    await waitFor(() => expect(screen.getAllByDisplayValue("live-value")).toHaveLength(2));
  });

  it("shows a plain empty state when there is no .env file yet", async () => {
    mockApi({ env: { status: 200, body: { entries: [], exists: false } } });
    mount();
    await waitFor(() => expect(screen.getByText(/no \.env file yet/i)).toBeTruthy());
  });

  it("shows only the row that was revealed after a mixed reveal/no-reveal render, scoped to its own row", async () => {
    // A narrower repeat of the "does not reveal another" test, scoped with `within` to
    // rule out the mask string match from also matching the OTHER row's readonly input.
    mockApi({
      env: {
        status: 200,
        body: {
          entries: [
            { key: "DB_PASSWORD", masked: MASK },
            { key: "PUID", masked: MASK },
          ],
          exists: true,
        },
      },
      reveal: (key) => ({
        status: 200,
        body: { key, value: key === "DB_PASSWORD" ? "hunter2" : "1000" },
      }),
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    const puidRow = screen.getByText("PUID").closest("tr");
    if (!puidRow) throw new Error("PUID row not found");
    fireEvent.click(screen.getAllByRole("button", { name: "Reveal" })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByDisplayValue("hunter2")).toBeTruthy());

    expect(within(puidRow).getByDisplayValue(MASK)).toBeTruthy();
  });

  it("does not leave the secret retrievable from the query cache after leaving raw mode", async () => {
    // The Critical finding this guards: raw mode used to fetch through `useQuery`, keyed
    // `[...envKey(appId), "raw"]` — TanStack's default `gcTime` (~5 minutes) kept the
    // whole file, secrets included, retrievable from the cache long after the tab went
    // back to Table and re-masked. There is nothing here worth caching, so there must be
    // nothing here TO retrieve.
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: () => ({
        status: 200,
        body: { content: FILE_CONTENT, hash: FILE_HASH, exists: true },
      }),
    });
    const { client } = mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    await waitFor(() => expect(screen.getByLabelText(".env file contents")).toBeTruthy());
    expect((screen.getByLabelText(".env file contents") as HTMLTextAreaElement).value).toBe(
      FILE_CONTENT,
    );

    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    expect(client.getQueryData([...envKey(app.id), "raw"])).toBeUndefined();
  });

  it("asks the server again on a second raw-mode open, rather than reusing anything cached", async () => {
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: () => ({
        status: 200,
        body: { content: FILE_CONTENT, hash: FILE_HASH, exists: true },
      }),
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    await waitFor(() => expect(screen.getByLabelText(".env file contents")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    await waitFor(() => expect(screen.getByLabelText(".env file contents")).toBeTruthy());

    const wholeFileCalls = revealCalls().filter((call) => call.key === undefined);
    expect(wholeFileCalls).toHaveLength(2);
  });

  it("stops and asks when a concurrent edit changed the same key, instead of silently keeping the older value", async () => {
    // The first Important finding: `upsertEnv` reapplies the browser's own value
    // unconditionally on retry. When the concurrent edit touched the SAME key, that
    // silently reverts whatever it just set — for a secrets file, often a credential
    // rotation.
    let wholeCalls = 0;
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: (key) => {
        if (key) return { status: 200, body: { key, value: "hunter2" } };
        wholeCalls++;
        return wholeCalls === 1
          ? { status: 200, body: { content: "DB_PASSWORD=hunter2\n", hash: "h1", exists: true } }
          : { status: 200, body: { content: "DB_PASSWORD=rotated\n", hash: "h2", exists: true } };
      },
      put: [{ status: 409, body: { error: "stale_hash", message: "Changed on disk." } }],
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => expect(screen.getByDisplayValue("hunter2")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("hunter2"), { target: { value: "newpass" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Someone else changed this variable/);

    // Not silently applied — only one PUT has happened, the one that got refused.
    expect(puts()).toHaveLength(1);

    fireEvent.click(screen.getByRole("radio", { name: /Keep mine/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save with these choices" }));

    await waitFor(() => expect(puts()).toHaveLength(2));
    const body = JSON.parse(puts()[1]?.body as string);
    expect(body).toEqual({ content: "DB_PASSWORD=newpass\n", expectedHash: "h2" });
    expect(screen.queryByText(/Someone else changed this variable/)).toBeNull();
  });

  it("merges a table edit onto a different concurrently-added key silently, with no prompt", async () => {
    // The binding check proving the two conflict checks above didn't just disable the
    // auto-merge feature entirely: a concurrent edit to a DIFFERENT key than the one this
    // tab touched still merges without asking, and nothing is lost either side.
    let wholeCalls = 0;
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: (key) => {
        if (key) return { status: 200, body: { key, value: "hunter2" } };
        wholeCalls++;
        return wholeCalls === 1
          ? { status: 200, body: { content: "DB_PASSWORD=hunter2\n", hash: "h1", exists: true } }
          : {
              status: 200,
              body: { content: "DB_PASSWORD=hunter2\nEXTRA=fromssh\n", hash: "h2", exists: true },
            };
      },
      put: [
        { status: 409, body: { error: "stale_hash", message: "Changed on disk." } },
        { status: 200, body: { hash: "h3" } },
      ],
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => expect(screen.getByDisplayValue("hunter2")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("hunter2"), { target: { value: "newpass" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts()).toHaveLength(2));
    const secondBody = JSON.parse(puts()[1]?.body as string);
    expect(secondBody).toEqual({
      content: "DB_PASSWORD=newpass\nEXTRA=fromssh\n",
      expectedHash: "h2",
    });
    expect(screen.queryByText(/Someone else changed/)).toBeNull();
    expect(screen.queryByText(/Someone changed this file since you loaded it/)).toBeNull();
  });

  it("treats a concurrently deleted key as a conflict instead of silently re-adding it", async () => {
    // The second Important finding: `upsertEnv`'s `findLastIndex` returns -1 for a key
    // that is gone from the fresh file, and appends it again — quietly undoing whatever
    // deleted it.
    let wholeCalls = 0;
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: (key) => {
        if (key) return { status: 200, body: { key, value: "hunter2" } };
        wholeCalls++;
        return wholeCalls === 1
          ? { status: 200, body: { content: "DB_PASSWORD=hunter2\n", hash: "h1", exists: true } }
          : { status: 200, body: { content: "OTHER=1\n", hash: "h2", exists: true } };
      },
      put: [{ status: 409, body: { error: "stale_hash", message: "Changed on disk." } }],
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => expect(screen.getByDisplayValue("hunter2")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("hunter2"), { target: { value: "newpass" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Removed on disk while you were editing it/);

    // Not silently re-added — only the refused PUT has happened so far.
    expect(puts()).toHaveLength(1);

    fireEvent.click(screen.getByRole("radio", { name: /Accept the removal/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save with these choices" }));

    await waitFor(() => expect(puts()).toHaveLength(2));
    const body = JSON.parse(puts()[1]?.body as string);
    expect(body).toEqual({ content: "OTHER=1\n", expectedHash: "h2" });
  });

  it("adds a new variable in the table without touching raw mode or any secret", async () => {
    // Minor from the final review: before this, adding `TZ=Europe/London` meant
    // switching to Raw — fetching and displaying every secret in the file for what
    // should be the most routine `.env` edit there is.
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "TZ" } });
    fireEvent.change(screen.getByLabelText("Value"), {
      target: { value: "Europe/London" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));

    expect(screen.getByText("TZ")).toBeTruthy();
    expect(screen.getByDisplayValue("Europe/London")).toBeTruthy();
    // No secret was ever fetched to do this.
    expect(revealCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(puts()[0]?.body as string);
    // The base this save applies onto is the whole-file fetch `mockApi`'s default
    // `reveal` answers with — `FILE_CONTENT` — not the (differently-shaped) masked
    // `entries` this test passed just to get the table to render.
    expect(body).toEqual({
      content: "# Database\nDB_PASSWORD=hunter2\nPUID=1000 # keep this note\nTZ=Europe/London\n",
      expectedHash: FILE_HASH,
    });
  });

  it("refuses to add a variable with an invalid or duplicate name", async () => {
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "1BAD" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    expect(screen.getByRole("alert").textContent).toMatch(/must start with a letter/);

    fireEvent.change(screen.getByLabelText("New variable name"), {
      target: { value: "DB_PASSWORD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    expect(screen.getByRole("alert").textContent).toMatch(/already exists/);
    // Refused, not silently accepted: still exactly one row for it.
    expect(screen.getAllByText("DB_PASSWORD")).toHaveLength(1);
  });

  it("removes a pending addition without ever calling save", async () => {
    mockApi({ env: { status: 200, body: { entries: [], exists: false } } });
    mount();
    await waitFor(() => expect(screen.getByText(/no \.env file yet/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "TZ" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    expect(screen.getByText("TZ")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("TZ")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("deletes an existing key without revealing it first", async () => {
    mockApi({
      env: {
        status: 200,
        body: {
          entries: [
            { key: "DB_PASSWORD", masked: MASK },
            { key: "PUID", masked: MASK },
          ],
          exists: true,
        },
      },
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    const dbRow = screen.getByText("DB_PASSWORD").closest("tr");
    if (!dbRow) throw new Error("row not found");
    fireEvent.click(within(dbRow).getByRole("button", { name: "Delete" }));

    expect(within(dbRow).getByText("Will be removed on save.")).toBeTruthy();
    // Never revealed — deletion needs only the key's name.
    expect(revealCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(puts()[0]?.body as string);
    // `removeEnv` drops only the `DB_PASSWORD` line — the comment above it and PUID's
    // own inline note both survive untouched, the same guarantee `upsertEnv` gives a
    // value edit.
    expect(body).toEqual({
      content: "# Database\nPUID=1000 # keep this note\n",
      expectedHash: FILE_HASH,
    });
  });

  it("undoes a pending delete", async () => {
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Will be removed on save.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo delete" }));
    expect(screen.queryByText("Will be removed on save.")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("routes a 409 on a delete straight to the whole-file conflict, not the per-key merge", async () => {
    // Structural edits (add/delete) get the same explicit conflict raw mode uses,
    // rather than the granular "merge everything but the keys that actually conflict"
    // treatment a plain rename gets — see the module doc comment.
    let wholeCalls = 0;
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: () => {
        wholeCalls++;
        return wholeCalls === 1
          ? { status: 200, body: { content: FILE_CONTENT, hash: FILE_HASH, exists: true } }
          : {
              status: 200,
              body: { content: "DB_PASSWORD=hunter2\nEXTRA=fromssh\n", hash: "h2", exists: true },
            };
      },
      put: [{ status: 409, body: { error: "stale_hash", message: "Changed on disk." } }],
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText(/Someone changed this file since you loaded it/);
    // Not the per-key dialog.
    expect(screen.queryByText(/Someone else changed/)).toBeNull();
    expect(puts()).toHaveLength(1);
  });

  it("distinguishes an unreadable file from a stale hash when the retry's own fetch fails", async () => {
    // The Minor finding: the retry's whole-file fetch can itself answer 409
    // `env_unreadable` — a permissions problem, not a concurrent edit — and showing
    // "Someone changed this file since you loaded it" for that would name the wrong
    // cause.
    let wholeCalls = 0;
    mockApi({
      env: { status: 200, body: { entries: [{ key: "DB_PASSWORD", masked: MASK }], exists: true } },
      reveal: (key) => {
        if (key) return { status: 200, body: { key, value: "hunter2" } };
        wholeCalls++;
        if (wholeCalls === 1) {
          return {
            status: 200,
            body: { content: "DB_PASSWORD=hunter2\n", hash: "h1", exists: true },
          };
        }
        return {
          status: 409,
          body: {
            error: "env_unreadable",
            message:
              "A .env file exists but Homestead cannot read it. Check its ownership and mode.",
          },
        };
      },
      put: [{ status: 409, body: { error: "stale_hash", message: "Changed on disk." } }],
    });
    mount();
    await waitFor(() => expect(screen.getByText("DB_PASSWORD")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => expect(screen.getByDisplayValue("hunter2")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("hunter2"), { target: { value: "newpass" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/cannot be read right now/);

    expect(screen.queryByText(/Someone changed this file since you loaded it/)).toBeNull();
    expect(puts()).toHaveLength(1);
  });
});
