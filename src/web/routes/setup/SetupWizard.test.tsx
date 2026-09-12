// @vitest-environment jsdom
import type { HostCheck, SetupState } from "@shared/setup.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SetupWizard } from "@web/routes/setup/SetupWizard";
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
 * same test. */
function stubState(state: SetupState) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/setup/host-check") return json(200, HEALTHY_HOST_CHECK);
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
    expect(screen.getByRole("button", { name: /Skip/ })).toBeTruthy();
  });

  it("does not offer Skip on the host step, which spec §9 does not mark skippable", async () => {
    stubState({ completedSteps: ["admin"], completedAt: null });
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Verify host/ })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("27.3.1")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Skip/ })).toBeNull();
  });

  it("does not double-fire a step's completion from a second click while the first is still in flight", async () => {
    // `StepPlaceholder`'s Skip button deliberately does not disable itself on `pending`
    // — it stands in for a step author who forgot. The wizard's own guard in
    // `markComplete` has to hold regardless, which is what this proves: the underlying
    // `.../complete` POST fires once, not twice, even though nothing in the DOM stopped
    // the second click from reaching the handler.
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
});
