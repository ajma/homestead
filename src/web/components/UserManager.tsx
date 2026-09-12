import { ROLES, type Role } from "@shared/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAdminApps } from "@web/api/admin";
import { ApiError, ApiTimeoutError, apiFetch } from "@web/api/client";
import { type ManagedUser, usersKey, useUsers } from "@web/api/users";
import { ConfirmDialog } from "@web/components/ConfirmDialog";
import { DialogShell } from "@web/components/DialogShell";
import { type ReactNode, useState } from "react";

const TIMEOUT_MESSAGE =
  "The server did not respond. It may still be working; check again in a moment.";

/**
 * True exactly for the 409 `PATCH`/`DELETE /api/users/:id` send when a change would
 * strip the last active administrator (`lastActiveAdminIsSafe` in
 * `src/server/routes/users.ts`) — demoting or disabling the sole admin, or deleting
 * them. The slug itself is not a sentence a housemate-facing screen should ever show.
 */
function isLastAdmin(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.body !== null &&
    typeof error.body === "object" &&
    "error" in error.body &&
    (error.body as { error: unknown }).error === "last_admin"
  );
}

function describeUserError(error: unknown, fallback: string): string {
  if (isLastAdmin(error)) {
    return "You cannot remove the last administrator. Promote or re-enable another admin first.";
  }
  if (error instanceof ApiTimeoutError) return TIMEOUT_MESSAGE;
  if (!(error instanceof ApiError)) {
    return "Could not reach the server. Check the network and try again.";
  }
  return fallback;
}

function scopeSummary(user: ManagedUser): string {
  return user.scopeAllApps ? "All apps" : "Specific apps";
}

/**
 * Name/email/password/role create form. Deliberately leaves scope untouched: the server
 * defaults a new user to `scopeAllApps: true` (`createUserSchema` in
 * `src/server/routes/users.ts`), and narrowing that is `EditScopeDialog`'s job, done
 * after the row exists rather than as a second decision this dialog forces up front.
 */
function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mutation = useMutation({
    mutationFn: (payload: { name: string; email: string; password: string; role: Role }) =>
      apiFetch<ManagedUser>("/api/users", { method: "POST", body: JSON.stringify(payload) }),
  });

  function handleCreate() {
    if (name.trim() === "") {
      setError("Name is required.");
      return;
    }
    if (email.trim() === "") {
      setError("Email is required.");
      return;
    }
    // Mirrors `createUserSchema`'s `password: z.string().min(12)` — a convenience so
    // the field can complain before a round trip. The server's schema is still the
    // boundary.
    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    setError(null);
    setSubmitting(true);

    mutation.mutate(
      { name, email, password, role },
      {
        onSuccess: () => {
          setSubmitting(false);
          queryClient.invalidateQueries({ queryKey: usersKey });
          onClose();
        },
        onError: (mutationError) => {
          setSubmitting(false);
          setError(describeUserError(mutationError, "Something went wrong creating the user."));
        },
      },
    );
  }

  return (
    <DialogShell title="Add user" onClose={onClose}>
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-900 dark:text-slate-100">Role</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r === "admin" ? "Administrator" : "Viewer"}
                </option>
              ))}
            </select>
          </label>

          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleCreate}
          disabled={submitting}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {submitting ? "Creating…" : "Create"}
        </button>
      </div>
    </DialogShell>
  );
}

/**
 * `PUT /api/users/:id/scope`'s editor. Starts from `{ scopeAllApps: user.scopeAllApps,
 * appIds: [] }` rather than the user's persisted app list — `GET /api/users` (this
 * screen's only read of any user but the caller) never returns `appIds`; only
 * `GET /api/me` does, off the caller's own `AuthContext`. Reopening this dialog for an
 * already-scoped user therefore cannot show which apps are currently checked — the
 * admin picks a fresh set each time, which is exactly what `PUT`'s full-replace
 * semantics already expect.
 */
function EditScopeDialog({ user, onClose }: { user: ManagedUser; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: apps } = useAdminApps();
  const [scopeAllApps, setScopeAllApps] = useState(user.scopeAllApps);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mutation = useMutation({
    mutationFn: (payload: { scopeAllApps: boolean; appIds?: string[] }) =>
      apiFetch(`/api/users/${user.id}/scope`, { method: "PUT", body: JSON.stringify(payload) }),
  });

  function toggleApp(appId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      return next;
    });
  }

  function handleSave() {
    setError(null);
    setSubmitting(true);

    // `appIds` is meaningless once `scopeAllApps` is true — `PUT /api/users/:id/scope`
    // only rebuilds the scope table from it in the `false` branch (`src/server/routes/
    // users.ts`) — so it is omitted entirely here rather than sent alongside a `true`
    // update. Sending it anyway would cost nothing today, but would leave a stale
    // selection from an earlier "specific apps" session sitting in the request as if it
    // still meant something.
    const payload: { scopeAllApps: boolean; appIds?: string[] } = scopeAllApps
      ? { scopeAllApps: true }
      : { scopeAllApps: false, appIds: [...selected] };

    mutation.mutate(payload, {
      onSuccess: () => {
        setSubmitting(false);
        queryClient.invalidateQueries({ queryKey: usersKey });
        onClose();
      },
      onError: (mutationError) => {
        setSubmitting(false);
        setError(describeUserError(mutationError, "Something went wrong saving this scope."));
      },
    });
  }

  return (
    <DialogShell title={`Edit scope for ${user.name}`} onClose={onClose}>
      <div className="flex-1 overflow-y-auto">
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="sr-only">App scope</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="scope-mode"
              checked={scopeAllApps}
              onChange={() => setScopeAllApps(true)}
            />
            All apps
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="scope-mode"
              checked={!scopeAllApps}
              onChange={() => setScopeAllApps(false)}
            />
            Specific apps
          </label>
        </fieldset>

        {!scopeAllApps && (
          <ul className="mt-3 flex flex-col gap-1">
            {(apps ?? []).map((app) => (
              <li key={app.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(app.id)}
                    onChange={() => toggleApp(app.id)}
                  />
                  {app.displayName}
                </label>
              </li>
            ))}
            {(apps ?? []).length === 0 && (
              <p className="text-sm text-slate-500">No apps to scope to yet.</p>
            )}
          </ul>
        )}

        {error && <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={submitting}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
      </div>
    </DialogShell>
  );
}

/**
 * The users manager: `GET/POST /api/users`, `PUT /api/users/:id/scope` and
 * `DELETE /api/users/:id`, all of which shipped in Phase 1A and were never called from a
 * browser until this task. `Settings` mounts this directly; Task 8's brief mounts it a
 * second time as step 5 of the setup wizard, with Skip/Finish chrome wrapped around it.
 * `disabled`/`actions` are the only two props this component takes, precisely so that
 * second caller never needs to reach inside it — the same two-prop shape `AdoptPanel`
 * already uses to serve both `AdoptDialog` and `StepImport`.
 *
 * Disabling and deleting are offered as two separate row actions on purpose: a disabled
 * user keeps their scope and history and can be re-enabled, a deleted one is gone for
 * good. Both — plus the confirmation in front of either — go through `ConfirmDialog`.
 * Its `onConfirm` can reject: the API answers 409 `last_admin` for either action when it
 * would leave zero administrators able to sign in, and the dialog stays open showing
 * that refusal in place rather than closing over it (see `ActionBar`'s `confirmingStop`
 * for the established pattern this follows).
 */
export function UserManager({
  disabled = false,
  actions,
}: {
  /** An extra reason, beyond this component's own in-flight requests, that its controls
   * must not fire — the wizard passes its own step-completion pending state here,
   * mirroring `AdoptPanel`'s identical prop. */
  disabled?: boolean;
  /** Footer buttons rendered after this panel's own content: nothing for `Settings`,
   * Skip/Finish for the wizard's users step. */
  actions?: ReactNode;
}) {
  const { data: users, isPending, isError } = useUsers();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [scopingUser, setScopingUser] = useState<ManagedUser | null>(null);
  const [disablingUser, setDisablingUser] = useState<ManagedUser | null>(null);
  const [deletingUser, setDeletingUser] = useState<ManagedUser | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: usersKey });
  }

  async function handleEnable(user: ManagedUser) {
    setRowError(null);
    try {
      await apiFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: false }),
      });
      invalidate();
    } catch (error) {
      // Re-enabling can never strip an administrator's power, so it never hits
      // `last_admin` — it still gets the same generic handling as everything else here,
      // for a network failure or a timeout.
      setRowError(describeUserError(error, "Something went wrong re-enabling this user."));
    }
  }

  async function handleDisableConfirmed(user: ManagedUser) {
    await apiFetch(`/api/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({ disabled: true }),
    });
    invalidate();
  }

  async function handleDeleteConfirmed(user: ManagedUser) {
    await apiFetch(`/api/users/${user.id}`, { method: "DELETE" });
    invalidate();
  }

  if (isPending) return <p className="p-6 text-sm text-slate-500">Loading users…</p>;
  if (isError) return <p className="p-6 text-sm text-rose-600">Could not load users.</p>;

  const rows = users ?? [];

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold">Users</h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={disabled}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          Add user
        </button>
      </div>

      {rowError && <p className="mb-3 text-sm text-rose-600 dark:text-rose-400">{rowError}</p>}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No users yet.</p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Scope</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((user) => (
                <tr key={user.id} className="border-t border-slate-200 dark:border-slate-800">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900 dark:text-slate-100">{user.name}</p>
                    <p className="text-xs text-slate-500">{user.email}</p>
                  </td>
                  <td className="px-4 py-3 capitalize">{user.role}</td>
                  <td className="px-4 py-3">
                    {scopeSummary(user)}{" "}
                    <button
                      type="button"
                      onClick={() => setScopingUser(user)}
                      disabled={disabled}
                      className="ml-1 text-slate-500 underline disabled:opacity-50"
                    >
                      Edit scope
                    </button>
                  </td>
                  <td className="px-4 py-3">{user.disabledAt === null ? "Active" : "Disabled"}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      {user.disabledAt === null ? (
                        <button
                          type="button"
                          onClick={() => setDisablingUser(user)}
                          disabled={disabled}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-800"
                        >
                          Disable
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleEnable(user)}
                          disabled={disabled}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-800"
                        >
                          Enable
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setDeletingUser(user)}
                        disabled={disabled}
                        className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-600 disabled:opacity-50 dark:border-rose-900 dark:text-rose-400"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {actions && <div className="mt-4 flex justify-end gap-2">{actions}</div>}

      {creating && <CreateUserDialog onClose={() => setCreating(false)} />}
      {scopingUser && <EditScopeDialog user={scopingUser} onClose={() => setScopingUser(null)} />}
      {disablingUser && (
        <ConfirmDialog
          title="Disable user"
          message={`Disable ${disablingUser.name}? They will keep their scope and history and can be re-enabled later.`}
          confirmLabel="Disable"
          onConfirm={() => handleDisableConfirmed(disablingUser)}
          onClose={() => setDisablingUser(null)}
          formatError={(error) =>
            describeUserError(error, "Something went wrong disabling this user.")
          }
        />
      )}
      {deletingUser && (
        <ConfirmDialog
          title="Delete user"
          message={`Delete ${deletingUser.name}? This permanently removes their account and cannot be undone.`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => handleDeleteConfirmed(deletingUser)}
          onClose={() => setDeletingUser(null)}
          formatError={(error) =>
            describeUserError(error, "Something went wrong deleting this user.")
          }
        />
      )}
    </div>
  );
}
