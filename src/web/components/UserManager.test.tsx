// @vitest-environment jsdom
import type { AdminApp } from "@shared/dto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ManagedUser } from "@web/api/users";
import { UserManager } from "@web/components/UserManager";
import { describe, expect, it, vi } from "vitest";

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

function app(over: Partial<AdminApp> = {}): AdminApp {
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type RecordedCall = { url: string; method: string; body: unknown };
type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | null;

/**
 * A tiny per-URL/method router over `fetch`, rather than one big stub per test — this
 * component fires off up to three distinct endpoints (`/api/users`, `/api/apps` for the
 * scope picker, and whichever of PATCH/PUT/DELETE a test exercises), and a single
 * catch-all response shape would either 404 legitimate requests or silently answer a
 * mutation with data meant for the list.
 */
function stubFetch(handlers: Handler[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      for (const handler of handlers) {
        const response = handler(url, init);
        if (response) return response;
      }
      return json(200, []);
    }),
  );
  return calls;
}

function usersList(url: string, init: RequestInit | undefined, users: ManagedUser[]) {
  return (!init?.method || init.method === "GET") && url.endsWith("/api/users")
    ? json(200, users)
    : null;
}

function appsList(url: string, init: RequestInit | undefined, apps: AdminApp[]) {
  return (!init?.method || init.method === "GET") && url.endsWith("/api/apps")
    ? json(200, apps)
    : null;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <UserManager />
      </QueryClientProvider>,
    ),
  };
}

describe("UserManager", () => {
  it("lists users with role and scope", async () => {
    stubFetch([
      (url, init) =>
        usersList(url, init, [
          user({ id: "u1", name: "Ann Admin", role: "admin", scopeAllApps: true }),
          user({
            id: "u2",
            name: "Vera Viewer",
            email: "vera@example.com",
            role: "viewer",
            scopeAllApps: false,
          }),
        ]),
    ]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    expect(screen.getByText("admin")).toBeTruthy();
    expect(screen.getByText("All apps")).toBeTruthy();
    expect(screen.getByText("Vera Viewer")).toBeTruthy();
    expect(screen.getByText("viewer")).toBeTruthy();
    expect(screen.getByText("Specific apps")).toBeTruthy();
  });

  it("shows an error only when there is nothing to show", async () => {
    stubFetch([(url, init) => usersList(url, init, [])]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(500, {})),
    );
    mount();
    await waitFor(() => expect(screen.getByText(/Could not load users/)).toBeTruthy());
  });

  it("creating a viewer posts name, email, password and role", async () => {
    const calls = stubFetch([
      (url, init) => usersList(url, init, [user()]),
      (url, init) =>
        init?.method === "POST" && url.endsWith("/api/users")
          ? json(
              201,
              user({ id: "u2", name: "New Viewer", email: "new@example.com", role: "viewer" }),
            )
          : null,
    ]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add user" }));

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Viewer" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse-battery" },
    });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/users"))).toBe(true),
    );
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/users"));
    expect(post?.body).toEqual({
      name: "New Viewer",
      email: "new@example.com",
      password: "correct-horse-battery",
      role: "viewer",
    });
  });

  it("changing scope to specific apps shows an app picker and sends appIds", async () => {
    const calls = stubFetch([
      (url, init) => usersList(url, init, [user({ scopeAllApps: true })]),
      (url, init) => appsList(url, init, [app({ id: "a1", displayName: "Jellyfin" })]),
      (url, init) =>
        init?.method === "PUT" && /\/scope$/.test(url)
          ? json(200, { scopeAllApps: false, appIds: ["a1"] })
          : null,
    ]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit scope" }));
    const dialog = screen.getByRole("dialog");

    fireEvent.click(within(dialog).getByLabelText("Specific apps"));
    await waitFor(() => expect(within(dialog).getByLabelText("Jellyfin")).toBeTruthy());
    fireEvent.click(within(dialog).getByLabelText("Jellyfin"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ scopeAllApps: false, appIds: ["a1"] });
  });

  // Important finding from Task 6/7's review: `GET /api/users` used to omit `appIds`
  // entirely, so this dialog always opened blank for an already-scoped user — an admin
  // narrowing access couldn't see what they were narrowing from, and saving silently
  // replaced the real scope with whatever the blank picker happened to have checked.
  it("opens the scope picker with a viewer's current two apps already checked", async () => {
    const calls = stubFetch([
      (url, init) => usersList(url, init, [user({ scopeAllApps: false, appIds: ["a1", "a3"] })]),
      (url, init) =>
        appsList(url, init, [
          app({ id: "a1", displayName: "Jellyfin" }),
          app({ id: "a2", slug: "gitea", displayName: "Gitea" }),
          app({ id: "a3", slug: "radarr", displayName: "Radarr" }),
        ]),
      (url, init) =>
        init?.method === "PUT" && /\/scope$/.test(url)
          ? json(200, { scopeAllApps: false, appIds: ["a1", "a3"] })
          : null,
    ]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit scope" }));
    const dialog = screen.getByRole("dialog");

    // `scopeAllApps: false` on the user means the checklist is already showing, with no
    // need to touch the "Specific apps" radio first.
    await waitFor(() => expect(within(dialog).getByLabelText("Jellyfin")).toBeTruthy());
    expect((within(dialog).getByLabelText("Jellyfin") as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText("Gitea") as HTMLInputElement).checked).toBe(false);
    expect((within(dialog).getByLabelText("Radarr") as HTMLInputElement).checked).toBe(true);

    // Saving without touching anything must round-trip exactly the two apps that were
    // pre-checked, not an empty selection.
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ scopeAllApps: false, appIds: ["a1", "a3"] });
  });

  // BINDING CHECK 1 (task-7-brief.md Step 3): sending `appIds` alongside a
  // `scopeAllApps: true` update must never happen — `appIds` is meaningless once scope
  // is "all apps", and a stale selection from an earlier "specific apps" session must
  // not ride along as if it still meant something.
  it("does not send a stale appIds list when scope is set to all apps", async () => {
    const calls = stubFetch([
      (url, init) => usersList(url, init, [user({ scopeAllApps: false })]),
      (url, init) => appsList(url, init, [app({ id: "a1", displayName: "Jellyfin" })]),
      (url, init) =>
        init?.method === "PUT" && /\/scope$/.test(url) ? json(200, { scopeAllApps: true }) : null,
    ]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit scope" }));
    const dialog = screen.getByRole("dialog");

    // Already defaults to the user's own `scopeAllApps: false`; switch back to "all
    // apps" without ever touching the (empty) app checklist, then save.
    fireEvent.click(within(dialog).getByLabelText("All apps"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ scopeAllApps: true });
    expect(put?.body).not.toHaveProperty("appIds");
  });

  it("deleting asks for confirmation naming the user", async () => {
    stubFetch([(url, init) => usersList(url, init, [user({ name: "Ann Admin" })])]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Ann Admin/)).toBeTruthy();
  });

  // BINDING CHECK 2 (task-7-brief.md Step 3): removing the delete confirmation must
  // make this fail — cancelling must never let a request reach the server.
  it("does not delete when the confirmation is cancelled", async () => {
    const calls = stubFetch([(url, init) => usersList(url, init, [user()])]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("deletes on confirmation and refreshes the list", async () => {
    const calls = stubFetch([
      (url, init) => usersList(url, init, [user()]),
      (_url, init) => (init?.method === "DELETE" ? new Response(null, { status: 204 }) : null),
    ]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers disabling a user as an action distinct from deleting", async () => {
    stubFetch([(url, init) => usersList(url, init, [user({ disabledAt: null })])]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/keep their scope and history/i)).toBeTruthy();
    expect(within(dialog).getByText(/re-enabled/i)).toBeTruthy();
  });

  it("re-enables a disabled user with no confirmation dialog", async () => {
    const calls = stubFetch([
      (url, init) => usersList(url, init, [user({ disabledAt: 1_800_000_000 })]),
      (_url, init) => (init?.method === "PATCH" ? json(200, user({ disabledAt: null })) : null),
    ]);
    mount();

    await waitFor(() => expect(screen.getByRole("button", { name: "Enable" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ disabled: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("promotes a viewer to admin", async () => {
    const calls = stubFetch([
      (url, init) =>
        usersList(url, init, [user({ id: "u2", name: "Vera Viewer", role: "viewer" })]),
      (_url, init) =>
        init?.method === "PATCH"
          ? json(200, user({ id: "u2", name: "Vera Viewer", role: "admin" }))
          : null,
    ]);
    mount();

    await waitFor(() => expect(screen.getByText("Vera Viewer")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Make admin" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ role: "admin" });
  });

  it("disables a row's own role-change button while its PATCH is still in flight", async () => {
    // `mutatingUserIds` is what stops a second click on THIS row from firing a second
    // PATCH before the first settles — distinct from `busy`, the aggregate a caller's
    // own footer button reads (already covered elsewhere: "actions(busy)" going false to
    // true and back). Unlike `SetupWizard`'s `pendingRef`, this guard IS the disabled
    // attribute — there is no separate ref backstop — so two ordinary, separately
    // dispatched clicks are enough to tell the guarded button from the unguarded one:
    // with the guard, the first click's `setMutatingUserIds` commits before the second
    // click is dispatched, so the button is genuinely disabled and jsdom refuses to
    // deliver the second click at all; delete the guard (`disabled={disabled}` only) and
    // the button stays enabled regardless, so the second click reaches the handler and
    // fires a second PATCH.
    const calls = stubFetch([
      (url, init) =>
        usersList(url, init, [user({ id: "u2", name: "Vera Viewer", role: "viewer" })]),
      (_url, init) => (init?.method === "PATCH" ? new Promise<Response>(() => {}) : null),
    ]);
    mount();

    await waitFor(() => expect(screen.getByText("Vera Viewer")).toBeTruthy());
    const makeAdmin = screen.getByRole("button", { name: "Make admin" });
    fireEvent.click(makeAdmin);
    fireEvent.click(makeAdmin);

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("renders the last_admin refusal as a sentence when a role change would demote the last admin", async () => {
    stubFetch([
      (url, init) => usersList(url, init, [user()]),
      (_url, init) => (init?.method === "PATCH" ? json(409, { error: "last_admin" }) : null),
    ]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Make viewer" }));

    await waitFor(() =>
      expect(screen.getByText(/cannot remove the last administrator/i)).toBeTruthy(),
    );
    expect(screen.queryByText("last_admin")).toBeNull();
  });

  it("renders the server's last_admin refusal as a sentence, not a slug, and stays open", async () => {
    stubFetch([
      (url, init) => usersList(url, init, [user()]),
      (_url, init) => (init?.method === "PATCH" ? json(409, { error: "last_admin" }) : null),
    ]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));

    await waitFor(() =>
      expect(within(dialog).getByText(/cannot remove the last administrator/i)).toBeTruthy(),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(dialog).queryByText("last_admin")).toBeNull();
  });

  it("renders the same last_admin refusal for a blocked delete", async () => {
    stubFetch([
      (url, init) => usersList(url, init, [user()]),
      (_url, init) => (init?.method === "DELETE" ? json(409, { error: "last_admin" }) : null),
    ]);
    mount();

    await waitFor(() => expect(screen.getByText("Ann Admin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(within(dialog).getByText(/cannot remove the last administrator/i)).toBeTruthy(),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
