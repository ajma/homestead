// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EditAppContext } from "@web/routes/EditApp";
import { ComposeTab } from "@web/routes/edit/ComposeTab";
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

const ORIGINAL = "services:\n  web:\n    image: nginx\n";

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/apps/jellyfin/compose"]}>
          <Routes>
            <Route
              path="/apps/:slug/*"
              element={<Outlet context={{ app } satisfies EditAppContext} />}
            >
              <Route path="compose" element={<ComposeTab />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

function findView(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container);
  if (!view) throw new Error("EditorView did not mount");
  return view;
}

/**
 * Same trick `YamlEditor.test.tsx` uses: jsdom does not implement contenteditable, so a
 * simulated keystroke never reaches CodeMirror's document. Dispatching a transaction
 * directly on the `EditorView` stands in for "the user typed something".
 *
 * Wrapped in `act` (matching `LogsTab.test.tsx`'s pattern for its own out-of-band
 * `FakeEventSource.emit`): the resulting `onChange` runs `setText` on `ComposeTab`, a
 * real React state update, but one CodeMirror delivers through its own event listener
 * rather than through a React event handler `fireEvent` would wrap automatically.
 * Without `act`, that update can still be pending when the very next line reads the
 * DOM synchronously.
 */
function typeInto(view: EditorView, text: string) {
  act(() => {
    const from = view.state.doc.length;
    view.dispatch({ changes: { from, to: from, insert: text } });
  });
}

/**
 * One fetch double that routes every URL this tab can call, matching `ProbesPanel.test.tsx`'s
 * shape: a single switch by method/path rather than a fresh `vi.fn` per test. `composeGets`
 * (a factory keyed by call number, 1-indexed) lets a test answer the *first* `GET .../compose`
 * — the tab's initial load — differently from a *later* one, which is exactly what the
 * conflict flow needs: the tab re-fetches the file after a 409 to show what changed.
 */
function mockApi(
  opts: {
    composeGets?: Array<{ status: number; body: unknown }>;
    composePuts?: Array<{ status: number; body: unknown }>;
    env?: { status: number; body: unknown };
    validate?: { status: number; body: unknown };
  } = {},
) {
  const composeGets = opts.composeGets ?? [
    { status: 200, body: { content: ORIGINAL, hash: "h1" } },
  ];
  const composePuts = opts.composePuts ?? [{ status: 200, body: { hash: "h2" } }];
  let getCalls = 0;
  let putCalls = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.endsWith("/compose/validate")) {
        const v = opts.validate ?? { status: 200, body: { valid: true } };
        return json(v.status, v.body);
      }
      if (url.endsWith("/env")) {
        const e = opts.env ?? { status: 200, body: { entries: [] } };
        return json(e.status, e.body);
      }
      if (url.endsWith("/compose") && method === "PUT") {
        const r = composePuts[Math.min(putCalls, composePuts.length - 1)];
        putCalls++;
        return json(r?.status ?? 200, r?.body ?? { hash: "h2" });
      }
      if (url.endsWith("/compose") && method === "GET") {
        const r = composeGets[Math.min(getCalls, composeGets.length - 1)];
        getCalls++;
        return json(r?.status ?? 200, r?.body ?? { content: ORIGINAL, hash: "h1" });
      }
      return json(200, {});
    }),
  );
}

/**
 * A `matchMedia` stub with the listener methods CodeMirror's own `DOMObserver` calls
 * unconditionally on mount (it watches the `print` media query regardless of what this
 * editor asks it for) — a bare `{ matches }` object crashes there with "addListener is
 * not a function" before this component's own `completionsEnabled` check ever runs.
 */
function stubMatchMedia(pointerFine: boolean) {
  vi.stubGlobal("matchMedia", ((query: string) => ({
    matches: query.includes("fine") ? pointerFine : false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia);
}

function puts(): RequestInit[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => init as RequestInit);
}

function validateCalls(): number {
  return vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/compose/validate"))
    .length;
}

/**
 * Real time, not fake timers: this file never stubs the clock (see the module doc on
 * `use-server-validate.test.tsx` for why fake timers get their own file when a hook needs
 * to control them precisely). 800ms clears the hook's 600ms debounce with margin. Wrapped
 * in `act` so any state update the debounce's `setTimeout` produces is flushed before the
 * next assertion reads the DOM or a mock's call list.
 */
async function settle(ms = 800) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ComposeTab", () => {
  it("loads and shows the file", async () => {
    mockApi();
    const { container } = mount();

    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    expect(findView(container).state.doc.toString()).toBe(ORIGINAL);
  });

  it("typing marks it dirty and enables Save", async () => {
    mockApi();
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);

    typeInto(findView(container), "\n# a note\n");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  it("sends the content with the hash it loaded", async () => {
    mockApi();
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

    typeInto(findView(container), "\n# a note\n");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(puts()[0]?.body as string);
    expect(body).toEqual({ content: `${ORIGINAL}\n# a note\n`, expectedHash: "h1" });
  });

  it("clears dirty and adopts the new hash on a successful save, so a second save works without reloading", async () => {
    mockApi({ composePuts: [{ status: 200, body: { hash: "h2" } }] });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    const view = findView(container);

    typeInto(view, "\n# first edit\n");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));

    // Dirty cleared: Save disabled again with no further typing.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true),
    );

    typeInto(view, "\n# second edit\n");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(2));

    // The second PUT carries the hash the FIRST save returned, not the one this tab
    // loaded with — proving it adopted the new hash rather than needing a reload.
    const secondBody = JSON.parse(puts()[1]?.body as string);
    expect(secondBody.expectedHash).toBe("h2");
  });

  it("does not silently discard your edits when the file changed underneath you", async () => {
    // The hash guard's whole purpose. Overwriting an SSH edit is unrecoverable, and so is
    // throwing away what the user just typed — so offer both texts, do neither.
    const diskContent = "services:\n  web:\n    image: nginx:alpine\n";
    mockApi({
      composeGets: [
        { status: 200, body: { content: ORIGINAL, hash: "h1" } },
        { status: 200, body: { content: diskContent, hash: "h2" } },
      ],
      composePuts: [
        {
          status: 409,
          body: { error: "stale_hash", message: "The file changed on disk since it was loaded." },
        },
      ],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    const view = findView(container);

    typeInto(view, "\n# my in-progress edit\n");
    const myText = view.state.doc.toString();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The conflict is reported...
    const banner = await screen.findByText(/Someone changed this file since you loaded it/);
    expect(banner).toBeTruthy();

    // ...but the user's text is untouched — not reverted, not overwritten.
    expect(view.state.doc.toString()).toBe(myText);

    // Both texts are available: theirs is still right there in the editor, and the
    // disk's current version can be shown alongside it.
    fireEvent.click(screen.getByText("Show the version currently on disk"));
    await waitFor(() => expect(screen.getByText(/nginx:alpine/)).toBeTruthy());

    // Reloading is offered, but clicking it does not immediately discard anything —
    // it asks first.
    fireEvent.click(screen.getByRole("button", { name: "Load the version on disk instead" }));
    expect(view.state.doc.toString()).toBe(myText);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/replaces the text in this tab/)).toBeTruthy();

    // Only the explicit confirmation actually replaces it.
    fireEvent.click(within(dialog).getByRole("button", { name: "Load it" }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(diskContent));
    expect(screen.queryByText(/Someone changed this file since you loaded it/)).toBeNull();
  });

  it("offers an explicit overwrite that resends the user's text against the fresh hash", async () => {
    // The other resolution: instead of loading the disk copy, deliberately overwrite it
    // with what's still in the editor. Must be an explicit, labelled choice — see the
    // "does not silently discard" test above for the property this must not break.
    const diskContent = "services:\n  web:\n    image: nginx:alpine\n";
    mockApi({
      composeGets: [
        { status: 200, body: { content: ORIGINAL, hash: "h1" } },
        { status: 200, body: { content: diskContent, hash: "h2" } },
      ],
      composePuts: [
        { status: 409, body: { error: "stale_hash", message: "Changed on disk." } },
        { status: 200, body: { hash: "h3" } },
      ],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    const view = findView(container);

    typeInto(view, "\n# mine\n");
    const myText = view.state.doc.toString();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Someone changed this file since you loaded it/);

    const overwriteButton = screen.getByRole("button", {
      name: "Keep mine — overwrite the disk version",
    });
    // Disabled until the disk fetch (fired alongside the conflict) resolves — there is
    // no fresh hash to overwrite against before then.
    await waitFor(() => expect(overwriteButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(overwriteButton);

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/saves your edits over what's currently on disk/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Overwrite" }));

    // The second PUT carries the user's own text, guarded by the FRESH hash the conflict
    // fetched (h2) — not the stale one that just bounced (h1), and not a silent no-op.
    await waitFor(() => expect(puts()).toHaveLength(2));
    const secondBody = JSON.parse(puts()[1]?.body as string);
    expect(secondBody).toEqual({ content: myText, expectedHash: "h2" });

    await waitFor(() =>
      expect(screen.queryByText(/Someone changed this file since you loaded it/)).toBeNull(),
    );
    // The overwrite resolved the conflict as a normal successful save: dirty clears.
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps editing untouched when the user chooses to keep their own version", async () => {
    mockApi({
      composePuts: [{ status: 409, body: { error: "stale_hash", message: "Changed on disk." } }],
    });
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    const view = findView(container);

    typeInto(view, "\n# mine\n");
    const myText = view.state.doc.toString();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Someone changed this file since you loaded it/);

    fireEvent.click(screen.getByRole("button", { name: "Keep editing my version" }));
    expect(screen.queryByText(/Someone changed this file since you loaded it/)).toBeNull();
    expect(view.state.doc.toString()).toBe(myText);
  });

  it("warns before navigating away with unsaved changes, but not with none", async () => {
    mockApi();
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    typeInto(findView(container), "\n# unsaved\n");

    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("says the file is unreadable rather than showing an empty editor", async () => {
    mockApi({
      composeGets: [
        { status: 500, body: { error: "internal_error", message: "Internal server error" } },
      ],
    });
    const { container } = mount();

    await waitFor(() => expect(screen.getByText(/Could not read compose\.yaml/)).toBeTruthy());
    expect(container.querySelector(".cm-editor")).toBeNull();
  });

  it("does not fetch .env keys for completions on a narrow viewport", async () => {
    // A fine pointer (so this isn't just re-testing desktop-only.ts's own pointer gate)
    // on a narrow window — the actual case `completionsEnabled`'s width check exists for.
    stubMatchMedia(true);
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    mockApi();
    const { container } = mount();

    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/env"))).toBe(false);
  });

  it("fetches .env keys for completions on a wide, fine-pointer viewport", async () => {
    stubMatchMedia(true);
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    mockApi({ env: { status: 200, body: { entries: [{ key: "DB_HOST" }] } } });
    const { container } = mount();

    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/env"))).toBe(true),
    );
  });

  describe("gating the server round trip", () => {
    it("validates once on open, before any edit, for a clean file", async () => {
      // This used to be gated on `dirty` too, on the theory that unedited text has
      // nothing new for `docker compose config` to say. Measured consequence: a file
      // that is only semantically broken never got checked until the user made a net
      // edit — see the next test. One spawn per tab open buys the answer the user came
      // for; repeated spawns while typing are what the debounce (and the syntax gate
      // below) actually guard against.
      mockApi();
      const { container } = mount();
      await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

      await settle();
      expect(validateCalls()).toBe(1);
      expect(
        screen.getByText("Server check not running — it runs again once you make another edit."),
      ).toBeTruthy();
    });

    it("answers a semantically-broken file on open without requiring an edit first", async () => {
      // Syntactically fine YAML — layer one's schema walk has nothing to say about it —
      // but `depends_on` names a service that doesn't exist, which only `docker compose
      // config` can catch. This is the exact case the regression this fix undoes broke:
      // opening the tab to ask "will this start?" got no answer until a net edit.
      const brokenContent = "services:\n  web:\n    depends_on: [databse]\n";
      mockApi({
        composeGets: [{ status: 200, body: { content: brokenContent, hash: "h1" } }],
        validate: {
          status: 200,
          body: { valid: false, message: 'service "web" depends on undefined service "databse"' },
        },
      });
      const { container } = mount();
      await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

      await settle();
      expect(validateCalls()).toBe(1);
      expect(screen.getByText('service "web" depends on undefined service "databse"')).toBeTruthy();
    });

    it("does not spawn a server check for a file that is syntactically broken on open", async () => {
      // The syntax gate must still block the load-time check too — layer one already
      // knows this document is broken, so a `docker compose config` spawn buys nothing.
      mockApi({ composeGets: [{ status: 200, body: { content: "bogus nginx\n", hash: "h1" } }] });
      const { container } = mount();
      await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

      await settle();
      expect(validateCalls()).toBe(0);
      expect(
        screen.getByText(
          "Server check paused until the YAML syntax error is fixed. Any message above may be stale.",
        ),
      ).toBeTruthy();
    });

    it("does not validate while layer one already reports a YAML syntax error", async () => {
      mockApi();
      const { container } = mount();
      await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

      // A bare scalar line where a mapping key is expected — the same shape of mistake
      // `yaml-lint.test.ts` uses to prove layer one reports a syntax error. `docker
      // compose config` would certainly fail on this too; sending it anyway would just be
      // paying for a subprocess to confirm what layer one already knows.
      typeInto(findView(container), "bogus nginx\n");

      await settle();
      expect(validateCalls()).toBe(0);
      expect(
        screen.getByText(
          "Server check paused until the YAML syntax error is fixed. Any message above may be stale.",
        ),
      ).toBeTruthy();
    });

    it("still validates a document that is both modified and syntactically valid", async () => {
      // The gate must actually gate rather than disable the round trip outright — a
      // dirty, syntax-clean document is exactly the case the server check exists for.
      mockApi();
      const { container } = mount();
      await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

      typeInto(findView(container), "\n# a harmless note\n");

      await settle();
      expect(validateCalls()).toBeGreaterThan(0);
    });
  });

  describe("extraExtensions memoisation survives consuming checking/transportError", () => {
    // Context worth re-stating rather than assuming: the final review's brief noted this
    // memoisation was verified stable across keystrokes, a settling query and the
    // validate debounce, and asked that any render-path change re-verify it rather than
    // assume it still holds. Important 3 above adds new render output driven by
    // `checking`/`transportError` state that changes independently of `desktop` and
    // `getEnvKeys` — `extraExtensions`'s own `useMemo` dependencies — so this proves
    // those state changes don't themselves cause `YamlEditor`'s compartments to
    // reconfigure. A `checking`/`transportError` toggle with no text edit is the cleanest
    // isolation: `extraExtensions` and `diagnostics` (keyed on `text`) would only dispatch
    // if something regressed, since nothing else in this window changes `readOnly` either.
    it("dispatches nothing to the editor while checking/transportError toggle with no text change", async () => {
      let resolveValidate: ((response: Response) => void) | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          const json = (status: number, body: unknown) =>
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            });
          if (url.endsWith("/compose/validate")) {
            return new Promise<Response>((resolve) => {
              resolveValidate = resolve;
            });
          }
          if (url.endsWith("/env")) return json(200, { entries: [] });
          if (url.endsWith("/compose")) return json(200, { content: ORIGINAL, hash: "h1" });
          return json(200, {});
        }),
      );
      const { container } = mount();
      await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
      await settle();
      expect(screen.getByText(/Checking with the server…/)).toBeTruthy();

      const view = findView(container);
      const dispatchSpy = vi.spyOn(view, "dispatch");

      // Settles `checking` back to `false` — no text change anywhere in this window.
      await act(async () => {
        resolveValidate?.(
          new Response(JSON.stringify({ valid: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      });
      await waitFor(() => expect(screen.queryByText(/Checking with the server…/)).toBeNull());

      expect(dispatchSpy).not.toHaveBeenCalled();
      dispatchSpy.mockRestore();
    });
  });

  describe("a stale verdict that nothing says is stale", () => {
    // Important 3 from the final review: `useServerValidate` computes `checking` and
    // `transportError` but the tab used to discard both, so a red banner about text the
    // user already fixed just sat there with no caption, no indicator and no retry once
    // the next check failed in transport (a dropped connection, or the rate limiter).

    it("shows an in-flight indicator while a check is running", async () => {
      let resolveValidate: ((response: Response) => void) | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          const json = (status: number, body: unknown) =>
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            });
          if (url.endsWith("/compose/validate")) {
            return new Promise<Response>((resolve) => {
              resolveValidate = resolve;
            });
          }
          if (url.endsWith("/env")) return json(200, { entries: [] });
          if (url.endsWith("/compose")) return json(200, { content: ORIGINAL, hash: "h1" });
          return json(200, {});
        }),
      );
      const { container } = mount();
      await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

      await settle();
      expect(screen.getByText(/Checking with the server…/)).toBeTruthy();

      // Cleans up: let the hanging request resolve so nothing leaks into the next test.
      await act(async () => {
        resolveValidate?.(
          new Response(JSON.stringify({ valid: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      });
    });

    it("says the server could not be reached when the next check fails in transport, without dropping the last real verdict", async () => {
      const brokenContent = "services:\n  web:\n    depends_on: [databse]\n";
      let validateCallCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          const json = (status: number, body: unknown) =>
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            });
          if (url.endsWith("/compose/validate")) {
            validateCallCount++;
            if (validateCallCount === 1) {
              return json(200, {
                valid: false,
                message: 'service "web" depends on undefined service "databse"',
              });
            }
            throw new TypeError("Failed to fetch");
          }
          if (url.endsWith("/env")) return json(200, { entries: [] });
          if (url.endsWith("/compose") && method === "GET") {
            return json(200, { content: brokenContent, hash: "h1" });
          }
          return json(200, {});
        }),
      );
      const { container } = mount();
      await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

      await settle();
      expect(screen.getByText('service "web" depends on undefined service "databse"')).toBeTruthy();

      // Fix the typo; the *next* validate fails in transport rather than answering.
      // `typeInto` only appends, so the whole-document replace goes straight through
      // the view, the same primitive `typeInto` itself dispatches through.
      const view = findView(container);
      act(() => {
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: brokenContent.replace("databse", "database"),
          },
        });
      });

      await settle();

      // The old verdict is still what's on screen — a transport failure must never be
      // rendered as a fresh, current answer — but now with a caption saying it may be
      // stale, not silence.
      expect(screen.getByText('service "web" depends on undefined service "databse"')).toBeTruthy();
      expect(screen.getByText(/Could not reach the server to check this file/)).toBeTruthy();
    });
  });
});
