// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
import type { HostCheck, SetupState } from "@shared/setup.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ManagedUser } from "@web/api/users";
import { SetupWizard } from "@web/routes/setup/SetupWizard";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fixture, not a real answer — good enough that `StepVerifyHost`, reached via Back
 * in the "review an earlier step" test, has a `HostCheck`-shaped body to render rather
 * than crashing on a `SetupState` it was never meant to receive. */
const HEALTHY_HOST_CHECK: HostCheck = {
  composeRoot: "/srv/homestead/apps",
  docker: { ok: true, version: "27.3.1", apiVersion: "1.47", os: "linux", arch: "arm64" },
  preflight: { ok: true },
};

/** Routes by URL rather than answering every request identically: this wizard's own
 * steps make their own requests (`StepVerifyHost`'s `GET /api/setup/host-check`, at
 * least), and a stub that always returns `state` would hand a step something shaped
 * nothing like what it asked for the moment more than one endpoint is exercised in the
 * same test.
 *
 * `users`/`apps` answer `GET /api/users`/`GET /api/apps` — `StepInviteUsers` (via
 * `UserManager`) and `FinishScreen` both read them once wired in for real, and a stub
 * that only knew about `host-check` would hand either a `SetupState` shaped nothing
 * like what it asked for, the same problem this function already solved for
 * `StepVerifyHost`. `finishedState`, when given, is what `POST /api/setup/finish`
 * answers with — standing in for the server's own one-way `completedAt` write. */
function stubState(
  state: SetupState,
  options: { users?: ManagedUser[]; apps?: AdminApp[]; finishedState?: SetupState } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/setup/host-check") return json(200, HEALTHY_HOST_CHECK);
      if (url === "/api/users") return json(200, options.users ?? []);
      if (url === "/api/apps") return json(200, options.apps ?? []);
      if (url === "/api/setup/finish" && (init?.method ?? "GET") === "POST") {
        return json(200, options.finishedState ?? { ...state, completedAt: 1_800_000_000 });
      }
      return json(200, state);
    }),
  );
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SetupWizard />
    </QueryClientProvider>,
  );
}

/**
 * Only the tests that reach `FinishScreen` need this: once `POST /api/setup/finish`
 * succeeds, that screen renders `<Navigate to="/" replace />` — a real router is what
 * turns that into an actual, assertable "landed on the launcher" rather than a prop
 * this test would otherwise have to trust blindly. The sibling `"/"` route stands in
 * for `App.tsx`'s own `<Launcher>` route; nothing about the guard under test cares what
 * that page actually is; the other `SetupWizard` tests never reach this branch, so they
 * stay on the plain `mount()` above rather than all paying for a router none of them
 * need.
 */
function mountWithRouter() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/setup"]}>
        <Routes>
          <Route path="/setup" element={<SetupWizard />} />
          <Route path="/" element={<p>You have reached the launcher</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SetupWizard", () => {
  it("renders step 1 on a fresh install", async () => {
    stubState({ completedSteps: [], completedAt: null });
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Create admin/ })).toBeTruthy());
  });

  it("resumes at the first incomplete step rather than starting over", async () => {
    // A browser closed halfway through setup must not mean doing it all again — especially
    // step 3, which adopts apps and would otherwise be re-offered as if nothing happened.
    stubState({ completedSteps: ["admin", "host"], completedAt: null });
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Import/ })).toBeTruthy());
  });

  it("shows the step indicator marking which steps are already done", async () => {
    stubState({ completedSteps: ["admin", "host"], completedAt: null });
    mount();

    await waitFor(() => expect(screen.getByRole("list")).toBeTruthy());
    const indicator = within(screen.getByRole("list"));
    expect(indicator.getByText("Create admin (done)")).toBeTruthy();
    expect(indicator.getByText("Verify host (done)")).toBeTruthy();
    // The current step (Import) and the one after it (Invite users) are listed but not
    // marked done — the indicator has to actually discriminate, not just always show
    // "(done)" once anything has.
    expect(indicator.getByText("Import")).toBeTruthy();
    expect(indicator.queryByText("Import (done)")).toBeNull();
    expect(indicator.queryByText(/Invite users \(done\)/)).toBeNull();
  });

  it("lets someone review an earlier, already-completed step via Back", async () => {
    // Resumability means the resume point can't move just because someone looked — Back
    // is for review, not for changing where a reload lands.
    stubState({ completedSteps: ["admin", "host"], completedAt: null });
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Import/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));

    await waitFor(() => expect(screen.getByRole("heading", { name: /Verify host/ })).toBeTruthy());
    // Waits for StepVerifyHost's own fetch to actually settle and render, rather than
    // stopping at the static heading — a stub answering every URL identically would
    // hand it a `SetupState` instead of a `HostCheck` and crash once this resolves.
    await waitFor(() => expect(screen.getByText("27.3.1")).toBeTruthy());
  });

  it("shows no Back affordance on the very first step", async () => {
    stubState({ completedSteps: [], completedAt: null });
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Create admin/ })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });

  it("offers Skip on the users step, which spec §9 marks skippable", async () => {
    stubState({ completedSteps: ["admin", "host", "import"], completedAt: null });
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Invite users/ })).toBeTruthy());
    // `UserManager` renders "Loading users…" and nothing else — no `actions` footer —
    // until `GET /api/users` settles, so Skip isn't on screen the instant the heading is.
    await waitFor(() => expect(screen.getByRole("button", { name: /Skip/ })).toBeTruthy());
  });

  it("does not offer Skip on the host step, which spec §9 does not mark skippable", async () => {
    stubState({ completedSteps: ["admin"], completedAt: null });
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Verify host/ })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("27.3.1")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Skip/ })).toBeNull();
  });

  it("does not double-fire a step's completion from a second click while the first is still in flight", async () => {
    // `StepImport`'s real Skip button disables itself once `pending` is true
    // (`disabled={pending || busy}`), and by the time this test's second `fireEvent.click`
    // runs, RTL has already flushed the first click's `setPending(true)` — so the button
    // is disabled in the DOM and jsdom refuses to dispatch the second click at all. That
    // proves Skip disables itself; it proves nothing about `markComplete`'s own
    // `pendingRef` guard, since the click never reaches the handler a second time either
    // way. The test below drives both clicks past that masking.
    const completeCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/complete")) {
          completeCalls.push(url);
          // Never resolves — keeps the wizard's own request "in flight" for the whole
          // test, so a second click lands squarely in the window the guard exists for.
          return new Promise<Response>(() => {});
        }
        return json(200, { completedSteps: ["admin", "host"], completedAt: null });
      }),
    );
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Import/ })).toBeTruthy());
    const skip = screen.getByRole("button", { name: /Skip/ });
    fireEvent.click(skip);
    fireEvent.click(skip);

    await waitFor(() => expect(completeCalls.length).toBeGreaterThan(0));
    // Give any errant second dispatch a chance to land before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completeCalls).toHaveLength(1);
  });

  it("guards markComplete itself against a second call that lands before the DOM disables Skip", async () => {
    // The test above is blind: `StepImport`'s Skip disables on `pending`, and each
    // `fireEvent.click` is its own `act()` that flushes the first click's re-render
    // before the second click ever dispatches — so the DOM's own disabled attribute is
    // what stops the second click, not `markComplete`'s `pendingRef` guard. Proven by
    // mutation: deleting `if (pendingRef.current) return;` from `markComplete` leaves
    // that test green.
    //
    // This test defeats the masking by firing both clicks inside a single `act()` call.
    // React batches the state update from the first click and does not commit it — so
    // Skip's `disabled` attribute in the DOM is still `false` — until this whole
    // callback returns, meaning the second `fireEvent.click` reaches the real button
    // while it is still enabled and its handler genuinely runs a second time. The only
    // thing left to stop a second `.../complete` POST at that point is `pendingRef`
    // itself: a plain mutable ref, set synchronously on the first call, unaffected by
    // React's batching.
    const completeCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/complete")) {
          completeCalls.push(url);
          return new Promise<Response>(() => {});
        }
        return json(200, { completedSteps: ["admin", "host"], completedAt: null });
      }),
    );
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Import/ })).toBeTruthy());
    const skip = screen.getByRole("button", { name: /Skip/ });

    act(() => {
      fireEvent.click(skip);
      fireEvent.click(skip);
    });

    await waitFor(() => expect(completeCalls.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completeCalls).toHaveLength(1);
  });

  it("reports the failing preflight reason when continuing past a failed mount check", async () => {
    // Step 2 deliberately allows continuing past a failed preflight (see
    // `StepVerifyHost`'s own doc comment) — this proves the wizard actually tells the
    // server what the user saw, rather than the completion looking identical to a clean
    // pass. `src/server/routes/setup-state.test.ts` covers the server side (that this
    // becomes an audit entry); this covers the client actually sending it.
    const failingHostCheck: HostCheck = {
      composeRoot: "/srv/homestead/apps",
      docker: { ok: true, version: "27.3.1", apiVersion: "1.47", os: "linux", arch: "arm64" },
      preflight: { ok: false, reason: "marker not visible from the daemon" },
    };
    const completeCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/setup/host-check") return json(200, failingHostCheck);
        if (url.endsWith("/complete")) {
          completeCalls.push(init?.body ? JSON.parse(String(init.body)) : undefined);
          return json(200, { completedSteps: ["admin", "host"], completedAt: null });
        }
        return json(200, { completedSteps: ["admin"], completedAt: null });
      }),
    );
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Verify host/ })).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByText(/marker not visible from the daemon/i)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

    await waitFor(() => expect(completeCalls).toHaveLength(1));
    expect(completeCalls[0]).toEqual({
      preflightOverride: { reason: "marker not visible from the daemon" },
    });
  });

  it("sends no preflightOverride when the mount check passed", async () => {
    // The mirror image: proves the wizard isn't sending a payload on every host
    // completion regardless of outcome, which would make the audit meaningless.
    const completeCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/setup/host-check") return json(200, HEALTHY_HOST_CHECK);
        if (url.endsWith("/complete")) {
          completeCalls.push(init?.body ? JSON.parse(String(init.body)) : undefined);
          return json(200, { completedSteps: ["admin", "host"], completedAt: null });
        }
        return json(200, { completedSteps: ["admin"], completedAt: null });
      }),
    );
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Verify host/ })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("27.3.1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

    await waitFor(() => expect(completeCalls).toHaveLength(1));
    // No body at all — `useCompleteStep` only attaches one when there's an override to
    // report, per its own doc comment — not an empty `{}` that would still put a
    // needless `content-type: application/json` on every ordinary step completion.
    expect(completeCalls[0]).toBeUndefined();
  });

  describe("finishing", () => {
    const ALL_DONE: SetupState = {
      completedSteps: ["admin", "host", "import", "users"],
      completedAt: null,
    };

    function managedUser(over: Partial<ManagedUser> = {}): ManagedUser {
      return {
        id: "u1",
        email: "ann@example.com",
        name: "Ann Admin",
        role: "admin",
        scopeAllApps: true,
        appIds: [],
        disabledAt: null,
        createdAt: 1_800_000_000,
        ...over,
      };
    }

    function adminApp(over: Partial<AdminApp> = {}): AdminApp {
      return {
        id: "a1",
        slug: "jellyfin",
        displayName: "Jellyfin",
        description: null,
        iconRef: null,
        category: null,
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
        ...over,
      };
    }

    it("summarises what was set up on the final screen, rather than a bare 'Done'", async () => {
      // Spec's wording: someone who just clicked through four screens deserves to see
      // the result. Step 1 always creates exactly one administrator before this screen
      // is reachable, so the two users below mean "one invited", not two.
      stubState(ALL_DONE, {
        apps: [adminApp({ id: "a1" }), adminApp({ id: "a2", slug: "gitea" })],
        users: [managedUser({ id: "u1" }), managedUser({ id: "u2", name: "Housemate" })],
      });
      mount();

      await waitFor(() => expect(screen.getByRole("heading", { name: /set up/i })).toBeTruthy());
      expect(screen.queryByText(/^Done$/)).toBeNull();
      await waitFor(() => expect(screen.getByText(/2 apps adopted/)).toBeTruthy());
      expect(screen.getByText(/1 user invited/)).toBeTruthy();
      // Spec §9: step 4 (Cloudflare exposure) is skippable and completable afterwards —
      // this is the moment to say so, since Phase 2 is where it actually lands.
      expect(screen.getByText(/Cloudflare/)).toBeTruthy();
    });

    it("finishing posts to /api/setup/finish and lands on the launcher", async () => {
      stubState(ALL_DONE, { apps: [], users: [managedUser()] });
      mountWithRouter();

      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Finish setup/ })).toBeTruthy(),
      );
      fireEvent.click(screen.getByRole("button", { name: /Finish setup/ }));

      await waitFor(() => {
        const post = vi
          .mocked(fetch)
          .mock.calls.find(
            (call) =>
              call[0] === "/api/setup/finish" && (call[1] as RequestInit)?.method === "POST",
          );
        expect(post).toBeTruthy();
      });
      await waitFor(() => expect(screen.getByText("You have reached the launcher")).toBeTruthy());
    });

    it("cannot be re-entered once finished — a fresh mount with completedAt set redirects straight to the launcher", async () => {
      // Completion is one-way: re-entering would offer "create the first admin" to a
      // second admin. `App.tsx`'s own route guard already refuses this from outside;
      // this proves `SetupWizard` itself refuses too, rather than relying solely on
      // being unmounted from above.
      stubState({ ...ALL_DONE, completedAt: 1_800_000_000 });
      mountWithRouter();

      await waitFor(() => expect(screen.getByText("You have reached the launcher")).toBeTruthy());
      expect(screen.queryByRole("heading", { name: /set up/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /Finish setup/ })).toBeNull();
    });
  });
});
