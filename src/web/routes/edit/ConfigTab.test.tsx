// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EditAppContext } from "@web/routes/EditApp";
import { ConfigTab } from "@web/routes/edit/ConfigTab";
import {
  createMemoryRouter,
  createRoutesFromElements,
  Outlet,
  Route,
  RouterProvider,
} from "react-router-dom";
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
  systemKind: null,
  showOnLauncher: true,
  sortOrder: 0,
  graceUntil: null,
  adoptedAt: 1_800_000_000,
  archivedAt: null,
  lastDeployAt: null,
  runningJobId: null,
};

const ORIGINAL = "services:\n  web:\n    image: nginx\n";

/**
 * Same shape as `ComposeTab.test.tsx`'s own `mount()`: a data router (not a plain
 * `MemoryRouter`/`Routes` tree), since both children this tab renders call
 * `useUnsavedChanges`, which calls `useBlocker`, which throws outside a data router. The
 * `overview` sibling exists only so the navigation-blocking tests below have somewhere to
 * navigate to that isn't `config` itself.
 */
function mount(setWideTab?: (wide: boolean) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route
        path="/apps/:slug/*"
        element={<Outlet context={{ app, setWideTab } satisfies EditAppContext} />}
      >
        <Route path="config" element={<ConfigTab />} />
        <Route path="overview" element={<p>Overview tab</p>} />
      </Route>,
    ),
    { initialEntries: ["/apps/jellyfin/config"] },
  );
  return {
    client,
    router,
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
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
 * One fetch double covering both children's endpoints at once — `ComposeTab.test.tsx`'s
 * and `EnvTab.test.tsx`'s own `mockApi`s merged, since this file is the one place both
 * mount together for real.
 */
function mockApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/compose/validate")) return json(200, { valid: true });
      if (url.endsWith("/compose") && method === "PUT") return json(200, { hash: "h2" });
      if (url.endsWith("/compose") && method === "GET") {
        return json(200, { content: ORIGINAL, hash: "h1" });
      }
      if (url.endsWith("/env/reveal") && method === "POST") {
        return json(200, { content: "TZ=UTC\n", hash: "e1", exists: true });
      }
      if (url.endsWith("/env") && method === "GET") {
        return json(200, { entries: [{ key: "TZ" }], exists: true });
      }
      if (url.endsWith("/env") && method === "PUT") return json(200, { hash: "e2" });
      return json(200, {});
    }),
  );
}

/**
 * Same reason `ComposeTab.test.tsx` stubs this: CodeMirror's `DOMObserver` calls
 * `matchMedia("print")`'s listener methods unconditionally on mount, and a bare
 * `{ matches }` object crashes there before this component's own `completionsEnabled`
 * check ever runs.
 */
function stubMatchMedia() {
  vi.stubGlobal("matchMedia", ((_query: string) => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia);
}

function findView(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container);
  if (!view) throw new Error("EditorView did not mount");
  return view;
}

/** Same trick `ComposeTab.test.tsx` uses: jsdom has no contenteditable, so a simulated
 * keystroke never reaches CodeMirror's document — dispatch a transaction directly. */
function typeInto(view: EditorView, text: string) {
  act(() => {
    const from = view.state.doc.length;
    view.dispatch({ changes: { from, to: from, insert: text } });
  });
}

async function addEnvVariable(key: string, value: string) {
  fireEvent.change(await screen.findByLabelText("New variable name"), { target: { value: key } });
  fireEvent.change(screen.getByLabelText("Value"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConfigTab", () => {
  it("opts out of EditApp's capped content column on mount, and opts back in on unmount", async () => {
    // `EditApp.tsx`'s `useWideEditLayout` is the mechanism `ConfigTab` uses to keep the
    // full row width instead of the capped, centred column every other tab gets — see
    // `density.ts`'s `EDIT_CONTENT_MAX_WIDTH` doc comment. This is the unit-level half of
    // that binding; `EditApp.test.tsx`'s "content row width" tests are the integration
    // half, proving `EditApp` itself actually reacts to the call this test proves happens.
    stubMatchMedia();
    mockApi();
    const setWideTab = vi.fn();
    const { container, router } = mount(setWideTab);
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

    expect(setWideTab).toHaveBeenCalledWith(true);

    await act(async () => {
      await router.navigate("/apps/jellyfin/overview");
    });

    expect(setWideTab).toHaveBeenLastCalledWith(false);
  });

  it("renders Compose and .env side by side, both live at once", async () => {
    stubMatchMedia();
    mockApi();
    const { container } = mount();

    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    // `EnvTab`'s masked table, not a "Loading .env…" placeholder — both children have
    // finished their own initial load simultaneously, not one after the other.
    await waitFor(() => expect(screen.getByText("TZ")).toBeTruthy());

    expect(
      within(screen.getByTestId("config-compose-pane")).getByRole("button", { name: "Save" }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("config-env-pane")).getByRole("button", { name: "Save" }),
    ).toBeTruthy();
  });

  it("stacks the two panes below the 768px breakpoint and sits them side by side above it, via Tailwind classes rather than measured width", async () => {
    // jsdom has no layout engine — this can't assert rendered geometry, only that the
    // mechanism actually deciding the breakpoint (a static Tailwind class list, same
    // 768px boundary `desktop-only.ts`'s `MIN_WIDTH` draws for completions) is wired the
    // way the doc comment on `ConfigTab` says it is.
    stubMatchMedia();
    mockApi();
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

    const wrapper = screen.getByTestId("config-compose-pane").parentElement;
    expect(wrapper?.className).toContain("flex-col");
    expect(wrapper?.className).toContain("md:flex-row");
  });

  it("blocks an in-app tab switch when only Compose is dirty, showing one combined dialog", async () => {
    stubMatchMedia();
    mockApi();
    const { container, router } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("TZ")).toBeTruthy());

    typeInto(findView(container), "\n# unsaved\n");

    await act(async () => {
      await router.navigate("/apps/jellyfin/overview");
    });

    expect(router.state.location.pathname).toBe("/apps/jellyfin/config");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const dialog = screen.getByRole("dialog");
    // `ConfigTab`'s own message, not `ComposeTab`'s own "compose.yaml has unsaved
    // changes" text — proving the child's own dialog stayed off while parented, and this
    // is the one hoisted blocker actually showing.
    expect(within(dialog).getByText(/compose\.yaml and\/or \.env/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes and leave" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/apps/jellyfin/overview"));
  });

  it("blocks an in-app tab switch when only .env is dirty", async () => {
    stubMatchMedia();
    mockApi();
    const { container, router } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

    await addEnvVariable("NEWKEY", "y");

    await act(async () => {
      await router.navigate("/apps/jellyfin/overview");
    });

    expect(router.state.location.pathname).toBe("/apps/jellyfin/config");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Discard changes and leave" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/apps/jellyfin/overview"));
  });

  it("shows exactly one dialog — never two — when both Compose and .env are dirty at once, and logs no react-router blocker warning", async () => {
    // The measured hazard this component exists to avoid: react-router 7.18.3 supports
    // only one active `useBlocker` at a time. Two independent ones would log "A router
    // only supports one blocker at a time" to the console and leave one of the two
    // reporting the wrong (unblocked) state — see `use-unsaved-changes.ts`'s own doc
    // comment. This proves the hoisted single blocker, not two, is what actually runs.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stubMatchMedia();
    mockApi();
    const { container, router } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

    typeInto(findView(container), "\n# unsaved\n");
    await addEnvVariable("NEWKEY", "y");

    await act(async () => {
      await router.navigate("/apps/jellyfin/overview");
    });

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((arg) => String(arg).includes("only supports one blocker")),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Discard changes and leave" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/apps/jellyfin/overview"));
  });

  it("does not block once both are clean again", async () => {
    stubMatchMedia();
    mockApi();
    const { container, router } = mount();
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());

    await act(async () => {
      await router.navigate("/apps/jellyfin/overview");
    });

    expect(router.state.location.pathname).toBe("/apps/jellyfin/overview");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
