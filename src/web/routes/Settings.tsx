import { UserManager } from "@web/components/UserManager";

/**
 * `/settings`, a `Placeholder` for six phases while the users CRUD API (Phase 1A) sat
 * unreachable from any browser. `App.tsx`'s own route guard already keeps this whole
 * subtree admin-only — a viewer is redirected to `/` before this ever mounts — so
 * nothing here re-checks role.
 */
export function Settings() {
  return (
    <div className="mx-auto max-w-5xl p-4">
      <h1 className="mb-4 text-lg font-semibold">Settings</h1>
      <UserManager />
    </div>
  );
}
