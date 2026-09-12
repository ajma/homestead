// @vitest-environment jsdom
import type { HostCheck, SetupState } from "@shared/setup.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StepVerifyHost } from "@web/routes/setup/StepVerifyHost";
import { describe, expect, it, vi } from "vitest";

const STATE: SetupState = { completedSteps: ["admin"], completedAt: null };

const HEALTHY: HostCheck = {
  composeRoot: "/srv/homestead/apps",
  docker: { ok: true, version: "27.3.1", apiVersion: "1.47", os: "linux", arch: "arm64" },
  preflight: { ok: true },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stub(...bodies: HostCheck[]) {
  const fn = vi.fn();
  for (const body of bodies) fn.mockImplementationOnce(async () => json(body));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function mount(onComplete = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onComplete,
    ...render(
      <QueryClientProvider client={client}>
        <StepVerifyHost state={STATE} onComplete={onComplete} />
      </QueryClientProvider>,
    ),
  };
}

describe("StepVerifyHost", () => {
  it("shows the compose root", async () => {
    stub(HEALTHY);
    mount();
    await waitFor(() => expect(screen.getByText("/srv/homestead/apps")).toBeTruthy());
  });

  it("shows the Docker version, API version, OS and arch verbatim", async () => {
    stub(HEALTHY);
    mount();
    await waitFor(() => expect(screen.getByText("27.3.1")).toBeTruthy());
    expect(screen.getByText("1.47")).toBeTruthy();
    expect(screen.getByText("linux")).toBeTruthy();
    expect(screen.getByText("arm64")).toBeTruthy();
  });

  it("shows a dead socket's own message and does not claim success", async () => {
    stub({
      composeRoot: "/srv/homestead/apps",
      docker: { ok: false, message: "connect ENOENT /var/run/docker.sock" },
      preflight: { ok: false, reason: "docker unreachable" },
    });
    mount();

    await waitFor(() =>
      expect(screen.getByText("connect ENOENT /var/run/docker.sock")).toBeTruthy(),
    );
    expect(screen.queryByText(/docker is reachable/i)).toBeNull();
  });

  it("shows a failed preflight's reason and explains the path-identity constraint", async () => {
    stub({
      composeRoot: "/srv/homestead/apps",
      docker: { ok: true, version: "27.3.1", apiVersion: "1.47", os: "linux", arch: "arm64" },
      preflight: { ok: false, reason: "marker not visible inside the container" },
    });
    mount();

    await waitFor(() =>
      expect(screen.getByText("marker not visible inside the container")).toBeTruthy(),
    );
    // The user cannot act on "preflight failed" alone — the screen has to say why: the
    // same absolute path on both sides, and what a wrong one silently does.
    expect(screen.getByText(/same absolute path inside the container as/i)).toBeTruthy();
    expect(screen.getByText(/silently created.*as an empty directory/i)).toBeTruthy();
    expect(screen.getByText(/symlinks on the host are fine/i)).toBeTruthy();
  });

  it("re-runs both checks from the re-check button", async () => {
    const fetchMock = stub(HEALTHY, HEALTHY);
    mount();

    await waitFor(() => expect(screen.getByText("27.3.1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Re-check/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("lets the user continue past a failed preflight, with the warning still shown", async () => {
    // A wrong bind mount is fixed outside Homestead, and a NAS admin mid-migration may
    // know better than we do. Trapping them on step 2 with no override is worse than
    // warning loudly — but the warning must not disappear when they proceed.
    stub({
      composeRoot: "/srv/homestead/apps",
      docker: { ok: true, version: "27.3.1", apiVersion: "1.47", os: "linux", arch: "arm64" },
      preflight: { ok: false, reason: "marker not visible inside the container" },
    });
    const onComplete = vi.fn();
    mount(onComplete);

    await waitFor(() =>
      expect(screen.getByText("marker not visible inside the container")).toBeTruthy(),
    );
    const continueButton = screen.getByRole("button", { name: /Continue/ });
    expect(continueButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(continueButton);

    expect(onComplete).toHaveBeenCalled();
    expect(screen.getByText("marker not visible inside the container")).toBeTruthy();
  });
});
