// @vitest-environment jsdom
import type { ScanResult } from "@shared/admin";
import type { SetupState } from "@shared/setup.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StepImport } from "@web/routes/setup/StepImport";
import { describe, expect, it, vi } from "vitest";

const STATE: SetupState = { completedSteps: ["admin", "host"], completedAt: null };

const SCAN: ScanResult = {
  discovered: [
    {
      directory: "jellyfin",
      composeFile: "compose.yaml",
      projectName: "jellyfin",
      containerCount: 2,
      running: true,
      adopted: false,
    },
    {
      directory: "gitea",
      composeFile: "docker-compose.yml",
      projectName: "gitea",
      containerCount: 1,
      running: false,
      adopted: false,
    },
    {
      directory: "taken",
      composeFile: "compose.yaml",
      projectName: "taken",
      containerCount: 1,
      running: true,
      adopted: true,
    },
  ],
  orphans: [{ projectName: "stray", containerCount: 3 }],
};

function stubScan(adoptResponse: unknown = { adopted: [], failed: [] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(JSON.stringify(init?.method === "POST" ? adoptResponse : SCAN), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function mount(
  props: Partial<{
    pending: boolean;
    onComplete: () => void;
    onFail: (m: string) => void;
    skippable: boolean;
  }> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onComplete = props.onComplete ?? vi.fn();
  const onFail = props.onFail ?? vi.fn();
  render(
    <QueryClientProvider client={client}>
      <StepImport
        state={STATE}
        pending={props.pending ?? false}
        onComplete={onComplete}
        onFail={onFail}
        skippable={props.skippable ?? true}
      />
    </QueryClientProvider>,
  );
  return { onComplete, onFail };
}

describe("StepImport", () => {
  it("lists discovered directories with project name, compose file, container count and running state", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    const row = screen.getByLabelText(/jellyfin/).closest("label");
    expect(row?.textContent).toContain("jellyfin");
    expect(row?.textContent).toContain("compose.yaml");
    expect(row?.textContent).toContain("2 containers");
    expect(row?.textContent).toContain("running");

    const gitea = screen.getByLabelText(/gitea/).closest("label");
    expect(gitea?.textContent).toContain("docker-compose.yml");
    expect(gitea?.textContent).toContain("1 container");
    expect(gitea?.textContent).toContain("stopped");
  });

  it("shows an already-adopted directory without a checkbox", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByText(/taken/)).toBeTruthy());
    expect(screen.queryByLabelText(/^taken/)).toBeNull();
  });

  it("surfaces orphan stacks with a line explaining what an orphan is", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByText(/stray/)).toBeTruthy());
    expect(screen.getByText(/no directory Homestead can see/)).toBeTruthy();
  });

  it("adopts only the checked directories", async () => {
    stubScan();
    mount();
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/jellyfin/));
    fireEvent.click(screen.getByRole("button", { name: /Adopt 1/ }));
    await waitFor(() => {
      const post = vi
        .mocked(fetch)
        .mock.calls.find((c) => (c[1] as RequestInit)?.method === "POST");
      // biome-ignore lint/correctness/noUnsafeOptionalChaining: a thrown TypeError here (no POST call found) fails the test just as loudly as a false assertion would.
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        directories: ["jellyfin"],
      });
    });
  });

  it("keeps the step open and names what failed on a partial failure, rather than advancing", async () => {
    // Advancing here would silently drop a directory the user explicitly checked — the
    // same regression `AdoptDialog`'s review flagged for closing on a partial failure.
    stubScan({
      adopted: [{ id: "a1", directory: "jellyfin" }],
      failed: [{ directory: "gitea", message: "compose_invalid" }],
    });
    const { onComplete } = mount();
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/jellyfin/));
    fireEvent.click(screen.getByLabelText(/gitea/));
    fireEvent.click(screen.getByRole("button", { name: /Adopt 2/ }));
    await waitFor(() => expect(screen.getByText(/gitea/)).toBeTruthy());
    expect(screen.getByText(/compose_invalid/)).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("advances after a fully successful adopt", async () => {
    stubScan({ adopted: [{ id: "a1", directory: "jellyfin" }], failed: [] });
    const { onComplete } = mount();
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/jellyfin/));
    fireEvent.click(screen.getByRole("button", { name: /Adopt 1/ }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it("is skippable", async () => {
    stubScan();
    mount({ skippable: true });
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    expect(screen.getByRole("button", { name: /Skip/ })).toBeTruthy();
  });

  it("marks the step complete on skip, so a resume does not re-offer it", async () => {
    stubScan();
    const { onComplete } = mount({ skippable: true });
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(onComplete).toHaveBeenCalled();
  });

  it("does not render Skip when the step is not skippable", async () => {
    stubScan();
    mount({ skippable: false });
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Skip/ })).toBeNull();
  });

  it("does not fire Skip while an adopt is in flight, even though the wizard's own pending is still false", async () => {
    // The Critical finding: Skip was gated only on the wizard's own `pending`, which
    // stays false for the entire window between clicking Adopt and that POST settling —
    // `pending` only flips true once `onComplete` has already fired, one step too late.
    // Checking a directory, clicking Adopt, then clicking Skip before the response
    // arrives must not advance the wizard: doing so leaves the admin with no idea
    // whether the directory they just checked was actually adopted.
    let resolvePost!: (response: Response) => void;
    const postResponse = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") return postResponse;
        return new Response(JSON.stringify(SCAN), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const { onComplete } = mount({ pending: false });
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/jellyfin/));
    fireEvent.click(screen.getByRole("button", { name: /Adopt 1/ }));

    // The adopt POST is now in flight; the wizard has not been told to complete
    // anything yet, so its own `pending` prop is still false.
    expect(screen.getByRole("button", { name: /Skip/ }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(onComplete).not.toHaveBeenCalled();

    resolvePost(
      new Response(JSON.stringify({ adopted: [{ id: "a1", directory: "jellyfin" }], failed: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it("disables Skip, Adopt, and the row checkboxes while the wizard's own completion request is pending", async () => {
    stubScan();
    mount({ pending: true });
    await waitFor(() => expect(screen.getByLabelText(/jellyfin/)).toBeTruthy());
    const checkbox = screen.getByLabelText(/jellyfin/);
    // The "checkboxes stay toggleable while disabled" finding: the row looked broken
    // because `disabled` reached the Adopt button but not the checkbox itself.
    //
    // Harness note: jsdom does not implement the HTML activation-behavior check that
    // makes a real browser's `disabled` attribute block a checkbox's click-driven state
    // change — `fireEvent.click` here still flips `checked` in jsdom even with the
    // attribute present, so this test can only assert the attribute exists, not that a
    // click is inert. A real browser (and screen readers, which key off the attribute)
    // do honour it.
    expect(checkbox.hasAttribute("disabled")).toBe(true);
    fireEvent.click(checkbox);
    expect(screen.getByRole("button", { name: /Skip/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Adopt 1/ }).hasAttribute("disabled")).toBe(true);
  });
});
