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
  isSystem: false,
  showOnLauncher: true,
  sortOrder: 0,
  graceUntil: null,
  adoptedAt: 1_800_000_000,
  archivedAt: null,
  lastDeployAt: null,
  runningJobId: null,
  ...over,
});

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

  it("lists each app with its status and directory", async () => {
    mount([app()]);
    expect(screen.getByText("Jellyfin")).toBeTruthy();
    expect(screen.getByText(/jellyfin/)).toBeTruthy();
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
    mount([app({ isSystem: true, displayName: "cloudflared" })]);
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
    it("offers deploy, restart and a shortcut to the compose editor", () => {
      stubRowFetch([app()]);
      mount([app()]);
      expect(screen.getByRole("button", { name: "Deploy" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
      const editorLink = screen.getByRole("link", { name: /Open in editor/ });
      expect(editorLink.getAttribute("href")).toBe("/apps/jellyfin/compose");
    });

    it("posts to the deploy action's own kind", async () => {
      const started = stubRowFetch([app()]);
      mount([app()]);

      fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

      await waitFor(() => expect(started).toContain("up"));
    });

    it("confirms before restarting, the one destructive row action", () => {
      stubRowFetch([app()]);
      mount([app()]);

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));

      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText(/Jellyfin/)).toBeTruthy();
    });

    it("does not post restart when the confirmation is cancelled", () => {
      const started = stubRowFetch([app()]);
      mount([app()]);

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

      expect(started).not.toContain("restart");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("posts restart once confirmed", async () => {
      const started = stubRowFetch([app()]);
      mount([app()]);

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      const dialog = screen.getByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));

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
        expect(screen.getByRole("button", { name: "Deploy" }).hasAttribute("disabled")).toBe(true),
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

      await waitFor(() =>
        expect(screen.getAllByRole("button", { name: "Deploy" })).toHaveLength(3),
      );
      // Give any errant per-row `useJobs` fetch a chance to fire before asserting its
      // absence.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const jobsRequests = vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).endsWith("/jobs"));
      expect(jobsRequests).toHaveLength(0);
    });

    it("disables a row's actions once one is started, until the job finishes", async () => {
      stubRowFetch([app()], { up: [{ status: 202, body: { jobId: "j1" } }] });
      mount([app()]);

      fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Deploy" }).hasAttribute("disabled")).toBe(true),
      );
    });

    it("invalidates only that app's key when a row action's job finishes, never the whole list", async () => {
      // The mistake 1E already made once: `adminAppsKey` is the Docker-touching endpoint
      // (`GET /api/apps`, up to four `docker compose config` spawns). A row action must
      // invalidate `adminAppKey(app.id)` — the same cache `ActionBar`'s own job-completion
      // handler refreshes — and never the whole inventory list.
      stubRowFetch([app()], { up: [{ status: 202, body: { jobId: "j1" } }] });
      const { client } = mount([app()]);
      const invalidateSpy = vi.spyOn(client, "invalidateQueries");

      fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

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
      // dead id, re-disabled Deploy/Restart and re-opened a second `JobOutput` stream for
      // a job that had already completed. This pins the fix without invalidating the
      // whole-inventory rollup (the sibling test above already pins that it must not).
      const seeded = app({ runningJobId: "existing-job" });
      stubRowFetch([seeded]);
      const { client, unmount } = mount([seeded]);

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Deploy" }).hasAttribute("disabled")).toBe(true),
      );

      act(() => {
        FakeEventSource.instances[0]?.emit("done", { status: "succeeded", exitCode: 0 });
      });

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Deploy" }).hasAttribute("disabled")).toBe(false),
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
        expect(screen.getByRole("button", { name: "Deploy" }).hasAttribute("disabled")).toBe(false),
      );
      expect(FakeEventSource.instances).toHaveLength(1);
    });
  });
});
