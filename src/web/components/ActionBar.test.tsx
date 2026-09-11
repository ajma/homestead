// @vitest-environment jsdom
import type { ImageStatusRow, JobRow } from "@shared/admin.js";
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { adminAppKey, adminAppsKey } from "@web/api/admin";
import { ActionBar } from "@web/components/ActionBar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no EventSource. Same double as `JobOutput.test.tsx`, `LogsTab.test.tsx` and
// `use-sse-text.test.tsx` — `ActionBar` opens one of these via the `JobOutput` it renders
// once a job is active.
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

function jobRow(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    appId: app.id,
    kind: "pull",
    status: "running",
    startedAt: 1_800_000_000,
    finishedAt: null,
    exitCode: null,
    output: null,
    userId: null,
    createdAt: 1_800_000_000,
    ...over,
  };
}

function imageRow(over: Partial<ImageStatusRow> = {}): ImageStatusRow {
  return {
    appId: app.id,
    serviceName: "web",
    currentDigest: "sha256:a",
    latestDigest: "sha256:a",
    updateAvailable: false,
    checkedAt: 1_800_000_000,
    ...over,
  };
}

type ActionResponse = { status: number; body: unknown };

/**
 * Multiplexes one `fetch` double across everything `ActionBar` calls: the four
 * `POST .../actions/:kind` routes, `GET .../jobs` (`useJobs`) and `GET .../images`
 * (`useImages`). Mirrors `ContainersTab.test.tsx`'s `stubList`, which answers both the
 * list route and the per-container detail route off one mock the same way a real Fastify
 * server would.
 *
 * `actions` queues responses per kind, consumed in order — a double-click needs its
 * second call to answer differently (a 409) from its first (a 202), which a single
 * static response per kind cannot express.
 */
function stubFetch(
  actions: Partial<Record<string, ActionResponse[]>> = {},
  extra: { jobs?: JobRow[]; images?: ImageStatusRow[] } = {},
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
      if (href.endsWith("/images")) {
        return new Response(JSON.stringify(extra.images ?? []), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return startedKinds;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ActionBar app={app} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActionBar", () => {
  it("renders the four lifecycle buttons", () => {
    stubFetch();
    mount();
    for (const name of ["Deploy", "Restart", "Pull", "Stop"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it.each([
    ["Deploy", "up"],
    ["Restart", "restart"],
    ["Pull", "pull"],
  ])("posts to the %s action's own kind", async (label, kind) => {
    const started = stubFetch();
    mount();

    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() => expect(started).toContain(kind));
  });

  it("disables every action while one is running", async () => {
    // The runner takes its mutex slot before any await, so a double-click cannot start
    // two jobs — but it can produce a 409 the user did not mean to cause.
    stubFetch({ up: [{ status: 202, body: { jobId: "j1" } }] });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pull" }).hasAttribute("disabled")).toBe(true),
    );
  });

  it("disables Stop too while a job is running, not just the quick actions", async () => {
    // Stop is rendered separately from `QUICK_ACTIONS` and carries its own `disabled`
    // attribute in the markup — a coverage gap the whole-branch review found: mutating
    // just Stop's `disabled={busy}` away left the suite green.
    stubFetch({ up: [{ status: 202, body: { jobId: "j1" } }] });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop" }).hasAttribute("disabled")).toBe(true),
    );
  });

  it("reports a timed-out action in words a person can act on, not the raw millisecond string", async () => {
    // `ApiTimeoutError`'s own message ("API request timed out after 30000ms") used to
    // reach the screen unmapped — Important 4 of the 1E final-fix brief. A timeout also
    // means the action may have gone through, unlike a rejection, so the wording differs
    // from `describeActionError`'s other branches too.
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            }),
        ),
      );
      mount();

      fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(
        screen.getByText(
          "The server did not respond. It may still be working; check again in a moment.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/API request timed out/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a 409 from a double-click as already running, not a failure", async () => {
    const started = stubFetch({
      up: [
        { status: 202, body: { jobId: "j1" } },
        {
          status: 409,
          body: {
            error: "job_running",
            message: "Another job is already running for this app.",
            runningJobId: "j1",
          },
        },
      ],
    });
    mount();
    const deploy = screen.getByRole("button", { name: "Deploy" });

    // The raw DOM `.click()`, not `fireEvent.click` — `fireEvent` wraps each call in its
    // own `act()`, which flushes the `disabled` re-render between the two calls and
    // would make the second click a no-op. Two native clicks in the same tick, with no
    // flush between them, is what actually reproduces a real double-click: both reach
    // the handler while the button's `disabled` attribute still reflects the pre-click
    // render (the same fact `ConfirmDialog`'s pending-guard tests rely on).
    deploy.click();
    deploy.click();

    await waitFor(() => expect(started.filter((k) => k === "up")).toHaveLength(2));
    await waitFor(() => expect(screen.getByText(/already running/i)).toBeTruthy());
    expect(screen.queryByText(/could not start/i)).toBeNull();
  });

  it("asks for confirmation before stopping, naming the app", () => {
    stubFetch();
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Jellyfin/)).toBeTruthy();
  });

  it("does not post down when the confirmation is cancelled", () => {
    const started = stubFetch();
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(started).not.toContain("down");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts the down job and closes the dialog once confirmed", async () => {
    const started = stubFetch({ down: [{ status: 202, body: { jobId: "job-down" } }] });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(started).toContain("down");
    expect(screen.getByTestId("job-output")).toBeTruthy();
  });

  it("keeps the confirmation open and shows a 409 in place when down is already running", async () => {
    const started = stubFetch({
      down: [
        {
          status: 409,
          body: { error: "job_running", message: "Another job is already running for this app." },
        },
      ],
    });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(within(dialog).getByText(/already running/i)).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(started).toContain("down");
  });

  it("streams the job's output while it runs and invalidates admin caches when it finishes", async () => {
    stubFetch({ up: [{ status: 202, body: { jobId: "j1" } }] });
    const { client } = mount();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(FakeEventSource.instances[0]?.url).toBe("/api/jobs/j1/stream");

    act(() => {
      FakeEventSource.instances[0]?.emit("output", { text: "deploying…", stream: "stdout" });
    });
    await waitFor(() => expect(screen.getByText(/deploying…/)).toBeTruthy());

    act(() => {
      FakeEventSource.instances[0]?.emit("done", { status: "succeeded", exitCode: 0 });
    });

    // `adminAppKey(id)` prefix-matches containers/jobs/images/probes, so that alone
    // covers the subview refetch; `adminAppKey(slug)` is the separate cache entry
    // `EditApp`'s own header lives under, since it resolves through `useAdminApp(slug)`
    // rather than the whole-inventory `adminAppsKey` (Important 3 of the 1E final-fix
    // brief — invalidating that list from here was the refetch storm this test used to
    // paper over).
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: adminAppKey(app.id) }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: adminAppKey(app.slug) });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: adminAppsKey });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pull" }).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.queryByTestId("job-output")).toBeNull();
  });

  it("starts already disabled and streaming when a job is already running for the app on mount", async () => {
    stubFetch({}, { jobs: [jobRow({ id: "existing-job", status: "running" })] });
    mount();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deploy" }).hasAttribute("disabled")).toBe(true),
    );
    expect(screen.getByTestId("job-output")).toBeTruthy();
    expect(FakeEventSource.instances[0]?.url).toBe("/api/jobs/existing-job/stream");
  });

  it("does not disable when the app's most recent job already finished", async () => {
    stubFetch({}, { jobs: [jobRow({ id: "old-job", status: "succeeded" })] });
    mount();

    await waitFor(() => expect(screen.getByRole("button", { name: "Deploy" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Deploy" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("job-output")).toBeNull();
  });

  it("flags the Pull button when an image update is available", async () => {
    stubFetch({}, { images: [imageRow({ updateAvailable: true })] });
    mount();

    const badge = await screen.findByText(/update available/i);
    const pull = screen.getByRole("button", { name: /Pull/ });
    expect(pull.contains(badge)).toBe(true);
  });

  it("does not flag Pull when no image has an update", async () => {
    stubFetch({}, { images: [imageRow({ updateAvailable: false })] });
    mount();

    await screen.findByRole("button", { name: "Pull" });
    expect(screen.queryByText(/update available/i)).toBeNull();
  });
});
