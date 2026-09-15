// @vitest-environment jsdom
import type { JobRow } from "@shared/admin.js";
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { adminAppKey, adminAppsKey } from "@web/api/admin";
import { AdminApps } from "@web/routes/AdminApps";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource. Same double as `ActionBar.test.tsx` — a row action's
// `JobOutput` (rendered while `activeJobId !== null`) opens one of these exactly the way
// `ActionBar` itself does, since both go through `useAppActions`.
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    );
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    const init = data === undefined ? {} : { data: JSON.stringify(data) };
    for (const fn of this.listeners.get(type) ?? []) {
      fn(new MessageEvent(type, init));
    }
  }
}

type ActionResponse = { status: number; body: unknown };

/**
 * Multiplexes one `fetch` double across the list route (`GET /api/apps`) and each row's
 * `POST /api/apps/:id/actions/:kind` — mirrors `ActionBar.test.tsx`'s `stubFetch`, since a
 * row action goes through the exact same `useAppActions` hook.
 *
 * Still answers `GET /api/apps/:id/jobs` with `extra.jobs` (default `[]`) rather than
 * dropping the branch: a row no longer calls it (`RowActions` reads `runningJobId` off
 * its own data — see `running-jobs.ts`), but keeping the stub honest is what makes "no
 * calls to `/jobs`" a real assertion below rather than one that would pass by accident
 * because the double never knew how to answer that URL in the first place.
 */
function stubRowFetch(
  seed: AdminApp[],
  actions: Partial<Record<string, ActionResponse[]>> = {},
  extra: { jobs?: JobRow[] } = {},
) {
  const startedKinds: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const href = String(url);
      const actionMatch = href.match(/\/actions\/(\w+)$/);
      if (actionMatch?.[1]) {
        const kind = actionMatch[1];
        startedKinds.push(kind);
        const queue = actions[kind];
        const next: ActionResponse = queue?.shift() ?? { status: 202, body: { jobId: "j1" } };
        return new Response(JSON.stringify(next.body), {
          status: next.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (href.endsWith("/jobs")) {
        return new Response(JSON.stringify(extra.jobs ?? []), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(seed), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return startedKinds;
}

const app = (over: Partial<AdminApp> = {}): AdminApp => ({
  id: "a1",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: null,
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
  exposureHostname: null,
  uptimeSince: null,
  ports: [],
  ...over,
});

/**
 * Row order as rendered — read off each row's own `<p>` (the name, plus any System/
 * Hidden badge), not off `seed`, so a test can tell the rendered DOM apart from the
 * data it started from. Deliberately not the whole `<a>`: `AppIcon`'s icon-less fallback
 * renders the name's first letter as a sibling `aria-hidden` div inside that same link,
 * which would double up as "NNine" for an app named "Nine".
 */
function rowNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("tbody tr")).map(
    (row) => row.querySelector("a p")?.textContent?.trim() ?? "",
  );
}

function mount(seed?: AdminApp[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) client.setQueryData(adminAppsKey, seed);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AdminApps />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe("AdminApps", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify([app()]), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists each app with its name and status", async () => {
    mount([app()]);
    expect(screen.getByText("Jellyfin")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
  });

  it("uses the shared page shell's width cap, not the old 1024px max-w-5xl", () => {
    // A data table with a 1024px cap is exactly the anti-pattern the density pass exists
    // to fix — pinned here as a class-string assertion since jsdom has no geometry.
    const { container } = mount([app()]);
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.className).toContain("max-w-[1328px]");
    expect(shell.className).not.toContain("max-w-5xl");
  });

  it("tightens row cell padding at md: and up to suit a data table, not a touch target", () => {
    mount([app()]);
    const cell = screen.getByText("Jellyfin").closest("td");
    expect(cell?.className).toContain("md:py-2");
    expect(cell?.className).not.toContain("md:py-3");
  });

  it("links each row to that app's edit page by slug", async () => {
    mount([app({ slug: "jellyfin" })]);
    expect(screen.getByRole("link", { name: /Jellyfin/ }).getAttribute("href")).toBe(
      "/apps/jellyfin",
    );
  });

  it("renders cached rows immediately rather than a spinner", () => {
    mount([app({ displayName: "Cached" })]);
    // Deliberately synchronous and unawaited: the property under test is that the row
    // is there in the very first render, straight from the cache, before any fetch
    // could possibly have resolved. `queryByText(/Loading/)` would pass here whether or
    // not cache-first rendering worked — nothing in this component ever renders that
    // word — so it asserted nothing. See the binding-check report for a demonstration.
    expect(screen.getByText("Cached")).toBeTruthy();
  });

  it("keeps showing cached rows when a background refetch fails", async () => {
    // The same defect the launcher shipped and had to fix: `isError` alone throws away
    // rows that are still in hand.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(adminAppsKey, [app({ displayName: "Still here" })]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AdminApps />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await client.invalidateQueries({ queryKey: adminAppsKey }).catch(() => {});
    // TanStack Query's notifyManager schedules the re-render via `setTimeout(fn, 0)`
    // (a macrotask), while the `invalidateQueries` await above only unblocks on
    // microtasks. Without this tick, `waitFor`'s first (synchronous) check would see
    // the pre-refetch DOM and pass immediately — true regardless of whether the error
    // branch is written correctly, which is not a binding test of the fix.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(screen.getByText("Still here")).toBeTruthy());
  });

  it("shows an error only when there is nothing cached to show", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    mount();
    await waitFor(() => expect(screen.getByText(/Could not load/)).toBeTruthy());
  });

  it("shows an empty state with both entry points when there are no apps", async () => {
    mount([]);
    await waitFor(() => expect(screen.getByText(/No apps yet/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Adopt from disk/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create app/ })).toBeTruthy();
  });

  it("marks a system app so it cannot be mistaken for one of yours", async () => {
    mount([app({ systemKind: "cloudflared", displayName: "cloudflared" })]);
    expect(screen.getByText(/System/)).toBeTruthy();
  });

  it("shows when an app is hidden from the launcher", async () => {
    mount([app({ showOnLauncher: false })]);
    expect(screen.getByText(/Hidden/)).toBeTruthy();
  });

  it("says 'Never' under Last deploy for an app that has never been deployed", async () => {
    mount([app({ lastDeployAt: null })]);
    expect(screen.getByText("Never")).toBeTruthy();
  });

  it("shows the age of the most recent deploy when there is one", async () => {
    const now = Math.floor(Date.now() / 1000);
    mount([app({ lastDeployAt: now - 60 })]);
    expect(screen.getByText(/1m ago/)).toBeTruthy();
  });

  describe("Uptime column", () => {
    it("shows a dash for an app with no running container", async () => {
      // `ports` is given a value here so the Ports column's own dash (also empty by
      // default) cannot be mistaken for this one — each column's "absent" case is
      // pinned by its own test below.
      mount([app({ uptimeSince: null, ports: [80] })]);
      expect(screen.getByText("—")).toBeTruthy();
    });

    it("shows how long the oldest running container has been up", async () => {
      const now = Math.floor(Date.now() / 1000);
      mount([app({ uptimeSince: now - 3600 })]);
      expect(screen.getByText("1h")).toBeTruthy();
    });
  });

  describe("Exposure column", () => {
    it("says 'Not exposed' for an app with no exposure", async () => {
      mount([app({ exposureHostname: null })]);
      expect(screen.getByText("Not exposed")).toBeTruthy();
    });

    it("shows the hostname for an app that is exposed", async () => {
      mount([app({ exposureHostname: "jellyfin.example.com" })]);
      expect(screen.getByText("jellyfin.example.com")).toBeTruthy();
    });
  });

  describe("Ports column", () => {
    it("shows a dash for an app with no published ports", async () => {
      const now = Math.floor(Date.now() / 1000);
      // `uptimeSince` is given a value here so the Uptime column's own dash cannot be
      // mistaken for this one.
      mount([app({ ports: [], uptimeSince: now - 60 })]);
      expect(screen.getByText("—")).toBeTruthy();
    });

    it("shows every published port, comma-separated", async () => {
      mount([app({ ports: [22, 443, 8080] })]);
      expect(screen.getByText("22, 443, 8080")).toBeTruthy();
    });
  });

  it("no longer shows a Directory column", async () => {
    mount([app({ directory: "jellyfin-data" })]);
    expect(screen.queryByText("jellyfin-data")).toBeNull();
  });

  it("does not claim a zero-services app is healthy", async () => {
    // `statusDetail` is null exactly when `statusFor` reports `unknown` — a probe that
    // never ran is not evidence of health, and the fallback must not say otherwise.
    mount([app({ status: "unknown", statusDetail: null })]);
    expect(screen.queryByText("Healthy")).toBeNull();
    expect(screen.getByText("Not checked yet")).toBeTruthy();
  });

  it("gives every row's status chip no button role, since there is no health panel here", async () => {
    mount([app()]);
    expect(screen.queryByRole("button", { name: /Show health details/ })).toBeNull();
  });

  describe("row actions", () => {
    it("offers restart, a shortcut to the config editor, and no Deploy button", () => {
      stubRowFetch([app()]);
      mount([app()]);
      expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
      const editorLink = screen.getByRole("link", { name: "Open in editor" });
      expect(editorLink.getAttribute("href")).toBe("/apps/jellyfin/config");
    });

    it("gives every icon button a real accessible name", () => {
      // Queried by role and name, not by test id: an icon-only control with no
      // accessible name would fail every `getByRole(..., { name })` lookup in this
      // file, but this is the one test whose whole point is that property.
      stubRowFetch([app({ status: "up" })]);
      mount([app({ status: "up" })]);
      expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Open in editor" })).toBeTruthy();
    });

    describe("Start/Stop toggle", () => {
      it("shows Start, not Stop, for a stopped app", () => {
        stubRowFetch([app({ status: "down" })]);
        mount([app({ status: "down" })]);
        expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
      });

      it("shows Stop, not Start, for a running app", () => {
        stubRowFetch([app({ status: "up" })]);
        mount([app({ status: "up" })]);
        expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
      });

      it("shows Stop for a degraded or starting app too — something is running", () => {
        for (const status of ["degraded", "starting"] as const) {
          const { unmount } = mount([app({ status })]);
          expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
          expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
          unmount();
        }
      });

      it("shows Start for an unknown-status app — nothing confirmed running", () => {
        mount([app({ status: "unknown" })]);
        expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
      });

      it("posts to up when Start is clicked for a stopped app, without confirming", async () => {
        const started = stubRowFetch([app({ status: "down" })]);
        mount([app({ status: "down" })]);

        fireEvent.click(screen.getByRole("button", { name: "Start" }));

        expect(screen.queryByRole("dialog")).toBeNull();
        await waitFor(() => expect(started).toContain("up"));
      });

      it("confirms before stopping, the one destructive row action", () => {
        stubRowFetch([app({ status: "up" })]);
        mount([app({ status: "up" })]);

        fireEvent.click(screen.getByRole("button", { name: "Stop" }));

        const dialog = screen.getByRole("dialog");
        expect(within(dialog).getByText(/Jellyfin/)).toBeTruthy();
      });

      it("does not post down when the stop confirmation is cancelled", () => {
        const started = stubRowFetch([app({ status: "up" })]);
        mount([app({ status: "up" })]);

        fireEvent.click(screen.getByRole("button", { name: "Stop" }));
        const dialog = screen.getByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

        expect(started).not.toContain("down");
        expect(screen.queryByRole("dialog")).toBeNull();
      });

      it("posts down once the stop is confirmed", async () => {
        const started = stubRowFetch([app({ status: "up" })]);
        mount([app({ status: "up" })]);

        fireEvent.click(screen.getByRole("button", { name: "Stop" }));
        const dialog = screen.getByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));

        await waitFor(() => expect(started).toContain("down"));
      });
    });

    it("posts to restart without confirming — unlike Stop, Restart does not open a dialog", async () => {
      const started = stubRowFetch([app()]);
      mount([app()]);

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(started).toContain("restart"));
    });

    it("disables a row's actions while that app already has a job running, matching ActionBar", async () => {
      // `runningJobId` comes straight off the row — `GET /api/apps`'s own grouped query
      // (`running-jobs.ts`) — not from a per-row `GET .../jobs` fetch. `stubRowFetch`
      // still answers that endpoint (see its own doc comment on why it must), but this
      // test seeds no `jobs` extra, so a green result here cannot be masking a row that
      // secretly still fetched it and just so happened to find a running job.
      const runningApp = app({ runningJobId: "existing-job" });
      stubRowFetch([runningApp]);
      mount([runningApp]);

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Stop" }).hasAttribute("disabled")).toBe(true),
      );
      expect(screen.getByRole("button", { name: "Restart" }).hasAttribute("disabled")).toBe(true);
    });

    it("fetches no row's job history separately when the inventory lists several apps", async () => {
      // The DOM looks identical whether a row reads `runningJobId` off its own data or
      // mounts `useJobs(app.id)` to re-derive it — so the only thing that can see this
      // defect is the request list itself. A twenty-app inventory used to fire twenty
      // `GET /api/apps/:id/jobs` requests on load; this asserts zero, for three rows.
      const seed = [
        app({ id: "a1", slug: "jellyfin" }),
        app({ id: "a2", slug: "gitea", runningJobId: "existing-job" }),
        app({ id: "a3", slug: "pihole" }),
      ];
      stubRowFetch(seed);
      mount(seed);

      await waitFor(() => expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(3));
      // Give any errant per-row `useJobs` fetch a chance to fire before asserting its
      // absence.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const jobsRequests = vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith("/jobs"));
      expect(jobsRequests).toHaveLength(0);
    });

    it("disables a row's actions once one is started, until the job finishes", async () => {
      stubRowFetch([app()], { restart: [{ status: 202, body: { jobId: "j1" } }] });
      mount([app()]);

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Restart" }).hasAttribute("disabled")).toBe(true),
      );
    });

    it("invalidates only that app's key when a row action's job finishes, never the whole list", async () => {
      // The mistake 1E already made once: `adminAppsKey` is the Docker-touching endpoint
      // (`GET /api/apps`, up to four `docker compose config` spawns plus a bounded batch
      // of container inspects). A row action must invalidate `adminAppKey(app.id)` — the
      // same cache `ActionBar`'s own job-completion handler refreshes — and never the
      // whole inventory list.
      stubRowFetch([app()], { restart: [{ status: 202, body: { jobId: "j1" } }] });
      const { client } = mount([app()]);
      const invalidateSpy = vi.spyOn(client, "invalidateQueries");

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));

      await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

      act(() => {
        FakeEventSource.instances[0]?.emit("done", { status: "succeeded", exitCode: 0 });
      });

      await waitFor(() =>
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: adminAppKey("a1") }),
      );
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: adminAppsKey });
    });

    it("clears a row's cached runningJobId once its job finishes, so a remount within staleTime doesn't re-disable it", async () => {
      // Since Task 2, `adminAppsKey` is the only cache holding `runningJobId` — nothing
      // else writes to it once a job finishes. Before this fix, a finished job's id
      // lingered in that cache: a remount inside the list's 15s `staleTime` re-read the
      // dead id, re-disabled the row's actions and re-opened a second `JobOutput` stream
      // for a job that had already completed. This pins the fix without invalidating the
      // whole-inventory rollup (the sibling test above already pins that it must not).
      const seeded = app({ runningJobId: "existing-job" });
      stubRowFetch([seeded]);
      const { client, unmount } = mount([seeded]);

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Stop" }).hasAttribute("disabled")).toBe(true),
      );

      act(() => {
        FakeEventSource.instances[0]?.emit("done", { status: "succeeded", exitCode: 0 });
      });

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Stop" }).hasAttribute("disabled")).toBe(false),
      );
      expect(client.getQueryData<AdminApp[]>(adminAppsKey)?.[0]?.runningJobId).toBeNull();

      unmount();
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <AdminApps />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Stop" }).hasAttribute("disabled")).toBe(false),
      );
      expect(FakeEventSource.instances).toHaveLength(1);
    });
  });

  describe("sorting", () => {
    it("shows apps in the order the API returned them until a header is clicked", () => {
      const { container } = mount([
        app({ id: "a1", displayName: "Zeta" }),
        app({ id: "a2", displayName: "Alpha" }),
        app({ id: "a3", displayName: "Mimas" }),
      ]);
      expect(rowNames(container)).toEqual(["Zeta", "Alpha", "Mimas"]);
    });

    it("sorts ascending on the first click, reverses on the second, and a different column starts ascending again", () => {
      // Severity order (Alpha=down, Gamma=degraded, Beta=up) deliberately disagrees with
      // alphabetical order past the first entry, so a stuck sort key — still comparing
      // by name after Status is clicked — could not produce the expected result by luck.
      const { container } = mount([
        app({ id: "a1", displayName: "Beta", status: "up" }),
        app({ id: "a2", displayName: "Alpha", status: "down" }),
        app({ id: "a3", displayName: "Gamma", status: "degraded" }),
      ]);

      fireEvent.click(screen.getByRole("button", { name: "App" }));
      expect(rowNames(container)).toEqual(["Alpha", "Beta", "Gamma"]);

      fireEvent.click(screen.getByRole("button", { name: "App" }));
      expect(rowNames(container)).toEqual(["Gamma", "Beta", "Alpha"]);

      fireEvent.click(screen.getByRole("button", { name: "Status" }));
      expect(rowNames(container)).toEqual(["Alpha", "Gamma", "Beta"]);
    });

    it("orders the App column alphabetically, not by raw character code", () => {
      // Naive `<` comparison sorts by UTF-16 code unit, putting every uppercase letter
      // before every lowercase one — "Banana" before "apple". `localeCompare` doesn't.
      const { container } = mount([
        app({ id: "a1", displayName: "cherry" }),
        app({ id: "a2", displayName: "Banana" }),
        app({ id: "a3", displayName: "apple" }),
      ]);

      fireEvent.click(screen.getByRole("button", { name: "App" }));
      expect(rowNames(container)).toEqual(["apple", "Banana", "cherry"]);
    });

    it("orders Status by severity, not alphabetically, surfacing what needs attention first", () => {
      // Alphabetical order over the status strings themselves would read "degraded,
      // down, starting, unknown, up" — differing from the expected order only in the
      // first two entries, so this is the minimal data that tells the two apart.
      const { container } = mount([
        app({ id: "a1", displayName: "Healthy", status: "up" }),
        app({ id: "a2", displayName: "Unknown", status: "unknown" }),
        app({ id: "a3", displayName: "Starting", status: "starting" }),
        app({ id: "a4", displayName: "Degraded", status: "degraded" }),
        app({ id: "a5", displayName: "Down", status: "down" }),
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Status" }));
      expect(rowNames(container)).toEqual(["Down", "Degraded", "Starting", "Unknown", "Healthy"]);

      fireEvent.click(screen.getByRole("button", { name: "Status" }));
      expect(rowNames(container)).toEqual(["Healthy", "Unknown", "Starting", "Degraded", "Down"]);
    });

    it("orders Uptime numerically, not as strings, and puts stopped apps last in both directions", () => {
      // [9, 10, 80] as strings sorts "10", "80", "9" — the classic trap.
      const { container } = mount([
        app({ id: "a1", displayName: "Eighty", uptimeSince: 80 }),
        app({ id: "a2", displayName: "Nine", uptimeSince: 9 }),
        app({ id: "a3", displayName: "Ten", uptimeSince: 10 }),
        app({ id: "a4", displayName: "Stopped", uptimeSince: null }),
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Uptime" }));
      expect(rowNames(container)).toEqual(["Nine", "Ten", "Eighty", "Stopped"]);

      fireEvent.click(screen.getByRole("button", { name: "Uptime" }));
      expect(rowNames(container)).toEqual(["Eighty", "Ten", "Nine", "Stopped"]);
    });

    it("orders Exposure alphabetically by hostname, and puts unexposed apps last in both directions", () => {
      const { container } = mount([
        app({ id: "a1", displayName: "Zulu", exposureHostname: "zulu.example.com" }),
        app({ id: "a2", displayName: "Alpha", exposureHostname: "alpha.example.com" }),
        app({ id: "a3", displayName: "NotExposed", exposureHostname: null }),
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Exposure" }));
      expect(rowNames(container)).toEqual(["Alpha", "Zulu", "NotExposed"]);

      fireEvent.click(screen.getByRole("button", { name: "Exposure" }));
      expect(rowNames(container)).toEqual(["Zulu", "Alpha", "NotExposed"]);
    });

    it("orders Ports by an app's lowest published port, numerically, and puts port-less apps last in both directions", () => {
      // Each app has several ports; the lowest of each set is 9, 10 and 80 — the same
      // [9, 10, 80] trap, now behind a `Math.min` over an array instead of a bare field.
      const { container } = mount([
        app({ id: "a1", displayName: "Eighty", ports: [80, 8080] }),
        app({ id: "a2", displayName: "Nine", ports: [9000, 9] }),
        app({ id: "a3", displayName: "Ten", ports: [10] }),
        app({ id: "a4", displayName: "NoPorts", ports: [] }),
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Ports" }));
      expect(rowNames(container)).toEqual(["Nine", "Ten", "Eighty", "NoPorts"]);

      fireEvent.click(screen.getByRole("button", { name: "Ports" }));
      expect(rowNames(container)).toEqual(["Eighty", "Ten", "Nine", "NoPorts"]);
    });

    it("orders Last deploy numerically, not as strings, and puts never-deployed apps last in both directions", () => {
      const { container } = mount([
        app({ id: "a1", displayName: "Eighty", lastDeployAt: 80 }),
        app({ id: "a2", displayName: "Nine", lastDeployAt: 9 }),
        app({ id: "a3", displayName: "Ten", lastDeployAt: 10 }),
        app({ id: "a4", displayName: "Never", lastDeployAt: null }),
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Last deploy" }));
      expect(rowNames(container)).toEqual(["Nine", "Ten", "Eighty", "Never"]);

      fireEvent.click(screen.getByRole("button", { name: "Last deploy" }));
      expect(rowNames(container)).toEqual(["Eighty", "Ten", "Nine", "Never"]);
    });

    it("reflects sort state in aria-sort on the sorted header, and 'none' on the rest", () => {
      mount([app({ id: "a1" }), app({ id: "a2", displayName: "Other" })]);

      const appHeader = screen.getByRole("columnheader", { name: "App" });
      const statusHeader = screen.getByRole("columnheader", { name: "Status" });
      expect(appHeader.getAttribute("aria-sort")).toBe("none");
      expect(statusHeader.getAttribute("aria-sort")).toBe("none");

      fireEvent.click(screen.getByRole("button", { name: "App" }));
      expect(appHeader.getAttribute("aria-sort")).toBe("ascending");
      expect(statusHeader.getAttribute("aria-sort")).toBe("none");

      fireEvent.click(screen.getByRole("button", { name: "App" }));
      expect(appHeader.getAttribute("aria-sort")).toBe("descending");
    });

    it("puts a real <button> in every sortable header, keyboard-reachable, and none in Actions", () => {
      mount([app()]);

      for (const label of ["App", "Status", "Uptime", "Exposure", "Ports", "Last deploy"]) {
        const header = screen.getByRole("columnheader", { name: label });
        expect(within(header).getByRole("button", { name: label }).tagName).toBe("BUTTON");
      }

      const actionsHeader = screen.getByRole("columnheader", { name: "Actions" });
      expect(within(actionsHeader).queryByRole("button")).toBeNull();
    });
  });
});
