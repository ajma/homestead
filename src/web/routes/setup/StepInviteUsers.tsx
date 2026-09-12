import { UserManager } from "@web/components/UserManager";
import type { SetupStepProps } from "./SetupWizard";

/**
 * Step 5 of onboarding, spec §9's "invite the household" — the same `UserManager`
 * `Settings` mounts (Phase 1A's user CRUD, first wired to a browser in Task 7), reached
 * here as part of first-run setup so a NAS admin can hand out accounts to housemates
 * before ever leaving the wizard. `Settings` and this step share one implementation on
 * purpose: two user-management screens that could drift on validation, the `last_admin`
 * guard, or scope editing would be a correctness bug waiting to happen, not a UI
 * inconsistency.
 *
 * `UserManager` has no notion of "done" the way `AdoptPanel` does (a fully successful
 * adopt is an unambiguous finish line; adding zero, one, or five users are all equally
 * valid outcomes here) — so nothing inside it ever calls `onComplete` on its own. Both
 * footer buttons below call it directly: Skip, for spec §9's "users is skippable", and
 * Finish, for an admin who's done inviting people and wants to move to the wizard's own
 * final screen. Both are otherwise identical (mark the step complete, once); they're
 * offered as two buttons rather than one purely so someone who has just added three
 * accounts isn't stuck pressing a button labelled "Skip" to move on.
 *
 * Skip and Finish are disabled on `busy` as well as `pending`, the same shape
 * `StepImport`'s Skip uses against `AdoptPanel`. Creating a user IS dialog-gated —
 * `DialogShell`'s `CreateUserDialog` is a full-viewport `fixed inset-0 z-50` overlay
 * that captures every click for as long as it's open, including the whole span of its
 * own submit, so there is no equivalent window to guard for that one action. But
 * `UserManager`'s "Make admin"/"Make viewer" and "Enable" are not gated behind anything:
 * each fires a bare `apiFetch` PATCH straight from the row, with nothing between a click
 * here and that request settling. Without `busy`, a click on one of those followed
 * immediately by a click on Skip or Finish was not blocked at all — `pending` stays
 * false for that entire window, since it only reflects the wizard's own completion
 * request, not anything happening inside `UserManager`. The impact was benign (the PATCH
 * completes server-side regardless of what the wizard does), but the guarantee this
 * comment used to claim did not exist; `busy` — true while `UserManager` has one of
 * those two in flight — is what makes it exist now.
 */
export function StepInviteUsers({ onComplete, pending, skippable }: SetupStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Invite users</h2>
        <p className="text-sm text-slate-500">
          Add an account for anyone else in the household who needs access. Everyone added here can
          be edited later from Settings — nothing below is final.
        </p>
      </div>

      <UserManager
        disabled={pending}
        actions={(busy) => (
          <>
            {skippable && (
              <button
                type="button"
                onClick={onComplete}
                disabled={pending || busy}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
              >
                Skip
              </button>
            )}
            <button
              type="button"
              onClick={onComplete}
              disabled={pending || busy}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              {pending ? "Continuing…" : "Finish"}
            </button>
          </>
        )}
      />
    </div>
  );
}
