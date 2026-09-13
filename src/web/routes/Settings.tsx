import { UserManager } from "@web/components/UserManager";
import { PAGE_SHELL, SECTION_GAP } from "@web/lib/density";
import { CloudflarePanel } from "@web/routes/settings/CloudflarePanel";
import { HostCheckPanel } from "@web/routes/setup/HostCheckPanel";

/**
 * `/settings`, a `Placeholder` for six phases while the users CRUD API (Phase 1A) sat
 * unreachable from any browser. `App.tsx`'s own route guard already keeps this whole
 * subtree admin-only — a viewer is redirected to `/` before this ever mounts — so
 * nothing here re-checks role.
 *
 * The host check reuses `HostCheckPanel` verbatim from `StepVerifyHost` (setup step 2)
 * — same query, same Re-check behaviour, no footer since there is no wizard step to
 * complete here. Setup's own `completedAt` is one-way and `finish` has no gate on which
 * steps ran, so an admin who continued past a failing mount preflight during setup, then
 * fixed it, had no way to confirm the fix short of a hand-crafted API call. Spec §9's
 * "can be completed later from settings" promise covers this the same way it covers
 * Cloudflare — `CloudflarePanel` below is that promise kept for the credentials half of
 * it (Phase 2A Task 3); everything else §6 promises is a later sub-phase's job.
 */
export function Settings() {
  return (
    <div className={`${PAGE_SHELL} ${SECTION_GAP}`}>
      <h1 className="text-lg font-semibold">Settings</h1>
      <section>
        <h2 className="mb-2 text-base font-semibold">Host check</h2>
        <p className="mb-4 text-sm text-slate-500">
          Re-run the Docker and mount checks from setup — useful after fixing a bind mount setup
          warned about.
        </p>
        <HostCheckPanel />
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold">Cloudflare</h2>
        <p className="mb-4 text-sm text-slate-500">
          Store the Cloudflare account and API token used to expose apps through a tunnel. The token
          is never shown again once saved — only its last four characters.
        </p>
        <CloudflarePanel />
      </section>
      <section>
        <UserManager />
      </section>
    </div>
  );
}
