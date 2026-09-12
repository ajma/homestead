// @vitest-environment jsdom
import type { SetupState } from "@shared/setup.js";
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

function stubState(state: SetupState) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(200, state)),
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

  it("does not strand the user on a blank screen when the state fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(500, { error: "boom" })),
    );
    mount();

    await waitFor(() =>
      expect(screen.getByText(/could not check how far setup has gotten/i)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
  });

  it("lets someone review an earlier, already-completed step via Back", async () => {
    // Resumability means the resume point can't move just because someone looked — Back
    // is for review, not for changing where a reload lands.
    stubState({ completedSteps: ["admin", "host"], completedAt: null });
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Import/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));

    await waitFor(() => expect(screen.getByRole("heading", { name: /Verify host/ })).toBeTruthy());
  });

  it("shows no Back affordance on the very first step", async () => {
    stubState({ completedSteps: [], completedAt: null });
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Create admin/ })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });
});
