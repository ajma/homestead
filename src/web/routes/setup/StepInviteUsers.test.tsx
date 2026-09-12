// @vitest-environment jsdom
import type { SetupState } from "@shared/setup.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ManagedUser } from "@web/api/users";
import { StepInviteUsers } from "@web/routes/setup/StepInviteUsers";
import { describe, expect, it, vi } from "vitest";

const STATE: SetupState = { completedSteps: ["admin", "host", "import"], completedAt: null };

function user(over: Partial<ManagedUser> = {}): ManagedUser {
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubUsers(users: ManagedUser[] = [user()]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((!init?.method || init.method === "GET") && url.endsWith("/api/users")) {
        return json(200, users);
      }
      return json(200, []);
    }),
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
      <StepInviteUsers
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

describe("StepInviteUsers", () => {
  it("renders the real UserManager wrapped in the wizard's own chrome", async () => {
    // Proves this is `UserManager` itself, not a fork of it — its own list rendering,
    // "Add user" button and table headers all come along for free rather than being
    // reimplemented here. A fork would drift from `Settings`' copy the next time either
    // one changed; this is exactly the drift Task 7 built `UserManager`'s
    // `{ disabled?, actions? }` shape to avoid.
    stubUsers([user({ name: "Ann Admin" })]);
    mount();

    await waitFor(() => expect(screen.getByRole("heading", { name: /Invite users/ })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Add user" })).toBeTruthy();
  });

  it("is skippable", async () => {
    stubUsers();
    mount({ skippable: true });

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    expect(screen.getByRole("button", { name: /Skip/ })).toBeTruthy();
  });

  it("does not render Skip when the step is not skippable", async () => {
    stubUsers();
    mount({ skippable: false });

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Skip/ })).toBeNull();
  });

  it("marks the step complete on skip, so a resume does not re-offer it", async () => {
    stubUsers();
    const { onComplete } = mount({ skippable: true });

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(onComplete).toHaveBeenCalled();
  });

  it("marks the step complete on Finish, the same as Skip", async () => {
    // Finish and Skip are functionally identical — `UserManager` has no notion of "done"
    // the way `AdoptPanel`'s fully-successful adopt does, so nothing here can call
    // `onComplete` on its own. Both buttons exist so someone who just added three
    // accounts isn't stuck pressing a button labelled "Skip" to move on.
    stubUsers();
    const { onComplete } = mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Finish/ }));
    expect(onComplete).toHaveBeenCalled();
  });

  it("disables Skip and Finish while the wizard's own completion request is pending", async () => {
    stubUsers();
    mount({ pending: true });

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    expect(screen.getByRole("button", { name: /Skip/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Continuing/ }).hasAttribute("disabled")).toBe(true);
  });

  it("passes pending through to UserManager as disabled, so Add user cannot be opened mid-completion", async () => {
    stubUsers();
    mount({ pending: true });

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Add user" }).hasAttribute("disabled")).toBe(true);
  });

  it("does not fire Skip while a role-change PATCH is in flight, even though the wizard's own pending is still false", async () => {
    // Task 8's review finding: this file's own doc comment used to claim "Make admin"/
    // "Make viewer" and "Enable" needed no guard because the only comparable action was
    // dialog-gated — false, since those two fire a bare PATCH with nothing between a
    // click here and that request settling. `pending` alone cannot cover this window: it
    // only reflects the wizard's own completion request, which has not been told
    // anything yet. Mirrors `StepImport`'s identical test for `AdoptPanel`'s `busy`.
    let resolvePatch!: (response: Response) => void;
    const patchResponse = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "PATCH") return patchResponse;
        if ((!init?.method || init.method === "GET") && url.endsWith("/api/users")) {
          return json(200, [user({ role: "viewer" })]);
        }
        return json(200, []);
      }),
    );
    const { onComplete } = mount({ skippable: true });

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Make admin" }));

    // The PATCH is now in flight; the wizard has not been told to complete anything, so
    // its own `pending` prop is still false.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Skip/ }).hasAttribute("disabled")).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(onComplete).not.toHaveBeenCalled();

    resolvePatch(json(200, { ...user(), role: "admin" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Skip/ }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
