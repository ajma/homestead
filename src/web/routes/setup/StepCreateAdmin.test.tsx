// @vitest-environment jsdom
import type { SetupState } from "@shared/setup.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StepCreateAdmin } from "@web/routes/setup/StepCreateAdmin";
import { describe, expect, it, vi } from "vitest";

const FRESH_STATE: SetupState = { completedSteps: [], completedAt: null };
const ADMIN_DONE_STATE: SetupState = { completedSteps: ["admin"], completedAt: null };

function ok(body: unknown = { id: "u1" }, status = 201) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function mount(state: SetupState, onComplete = vi.fn(), pending = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onComplete,
    ...render(
      <QueryClientProvider client={client}>
        <StepCreateAdmin
          state={state}
          onComplete={onComplete}
          pending={pending}
          onFail={vi.fn()}
          skippable={false}
        />
      </QueryClientProvider>,
    ),
  };
}

function fillForm({
  name = "Ada",
  email = "ada@example.com",
  password = "correct-horse-battery",
  confirmPassword = password,
}: {
  name?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
} = {}) {
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/Confirm password/), {
    target: { value: confirmPassword },
  });
}

describe("StepCreateAdmin", () => {
  it("renders name, email and password fields", () => {
    mount(FRESH_STATE);
    expect(screen.getByLabelText(/Name/)).toBeTruthy();
    expect(screen.getByLabelText(/Email/)).toBeTruthy();
    expect(screen.getByLabelText(/^Password/)).toBeTruthy();
    expect(screen.getByLabelText(/Confirm password/)).toBeTruthy();
  });

  it("says the account becomes the administrator and closes the bootstrap route", () => {
    mount(FRESH_STATE);
    expect(screen.getByText(/becomes the administrator/i)).toBeTruthy();
    expect(screen.getByText(/closes permanently/i)).toBeTruthy();
  });

  it("posts name, email and password to /api/setup/admin", async () => {
    ok();
    mount(FRESH_STATE);
    fillForm({ name: "Ada Lovelace", email: "ada@example.com", password: "correct-horse-battery" });
    fireEvent.click(screen.getByRole("button", { name: /Create admin/ }));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/setup/admin");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "correct-horse-battery",
    });
  });

  it("refuses a weak password client-side, with no request", async () => {
    mount(FRESH_STATE);
    fillForm({ password: "short", confirmPassword: "short" });
    fireEvent.click(screen.getByRole("button", { name: /Create admin/ }));

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/at least 12 characters/i)).toBeTruthy();
  });

  it("refuses a mismatched confirmation client-side, with no request", async () => {
    mount(FRESH_STATE);
    fillForm({ password: "correct-horse-battery", confirmPassword: "correct-horse-battery-2" });
    fireEvent.click(screen.getByRole("button", { name: /Create admin/ }));

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/do not match/i)).toBeTruthy();
  });

  it("renders the server's error slug as a sentence", async () => {
    ok({ error: "already_initialised" }, 409);
    mount(FRESH_STATE);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /Create admin/ }));

    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
  });

  it("shows an unmapped slug rather than a generic failure", async () => {
    ok({ error: "some_new_error" }, 500);
    mount(FRESH_STATE);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /Create admin/ }));

    await waitFor(() => expect(screen.getByText(/some_new_error/)).toBeTruthy());
  });

  it("does not create two accounts from a double submit", async () => {
    // The guard is set synchronously in the submit handler, before `mutate` is even
    // called — not derived from `mutation.isPending`, which TanStack's `notifyManager`
    // defers through `setTimeout(fn, 0)`. A never-resolving fetch keeps the button
    // disabled for the whole test, so a second `fireEvent.click` on an already-disabled
    // real DOM button cannot re-enter the handler at all.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    mount(FRESH_STATE);
    fillForm();

    const submit = screen.getByRole("button", { name: /Create admin/ });
    fireEvent.click(submit);
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(submit);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("advances on success without asking the user to log in again", async () => {
    ok();
    const onComplete = vi.fn();
    mount(FRESH_STATE, onComplete);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /Create admin/ }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // No login form appeared in between — the route signs the caller in.
    expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull();
  });

  it("renders as already-done, with no form, when a user already exists", () => {
    mount(ADMIN_DONE_STATE);
    expect(screen.getByText(/already exists/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Email/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Create admin/ })).toBeNull();
  });

  it("lets the user continue past the already-done state", () => {
    const onComplete = vi.fn();
    mount(ADMIN_DONE_STATE, onComplete);
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onComplete).toHaveBeenCalled();
  });

  it("disables Continue on the already-done screen while the wizard's own completion is pending", () => {
    mount(ADMIN_DONE_STATE, vi.fn(), true);
    expect(screen.getByRole("button", { name: /Continuing/ }).hasAttribute("disabled")).toBe(true);
  });

  it("disables the submit button while the wizard's own completion is pending", () => {
    mount(FRESH_STATE, vi.fn(), true);
    fillForm();
    expect(screen.getByRole("button", { name: /Continuing/ }).hasAttribute("disabled")).toBe(true);
  });
});
