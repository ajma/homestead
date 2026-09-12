import { AdoptPanel } from "@web/routes/AdoptPanel";
import type { SetupStepProps } from "./SetupWizard";

/**
 * Step 3 of onboarding, spec §8/§9's "adoption scan as a multi-select table": the same
 * flow `AdoptDialog` (Phase 1E) offers from the app list, reached here instead as part
 * of first-run setup so a NAS admin migrating existing stacks sees them on the very
 * first screen rather than discovering the dialog later. Read-only with respect to the
 * user's files — the scan (`GET /api/apps/scan`) only walks the compose root and lists
 * containers; nothing changes until directories are actually checked and Adopt is
 * pressed.
 *
 * `AdoptPanel` (extracted from `AdoptDialog` for this task) owns the scan listing,
 * selection, submission and partial-failure handling verbatim — this component supplies
 * only the chrome that differs: no dialog shell (this is a wizard step, not a modal),
 * and a Skip button instead of Cancel, since spec §9 marks `import` skippable.
 *
 * `onAllAdopted={onComplete}` mirrors `AdoptDialog`'s `onAllAdopted={onClose}`: a fully
 * successful adopt (zero entries in `failed`) is the one case that advances the wizard
 * automatically, the same way it closes the dialog. A response with any failures must
 * neither advance the wizard nor mark the step done — that would silently drop
 * directories the user explicitly checked, the exact regression Task 6's review flagged
 * for the dialog's own partial-failure path.
 *
 * `disabled={pending}` on `AdoptPanel` and the Skip button below both guard the same
 * moment: once a fully successful adopt has called `onComplete`, `SetupWizard`'s own
 * completion request (`markComplete`) is in flight and `pending` is true for at least
 * one macrotask (TanStack's `notifyManager` defers the re-render that would reflect a
 * mutation's own `isPending` through `setTimeout(fn, 0)` — see `AdoptPanel`'s and
 * `SetupWizard`'s own comments on the same trap). Unlike `StepPlaceholder`'s Skip button
 * — a stand-in that deliberately ignores `pending` to prove `SetupWizard`'s own
 * double-call guard holds without help — this is a real step, so it disables itself
 * properly rather than relying only on that backstop.
 *
 * Skip is also gated on `busy`, the argument `AdoptPanel`'s `actions` render prop
 * supplies — true for the entire window between a click on Adopt and that request
 * settling. `pending` alone cannot cover this window: it only becomes true once
 * `onComplete` has already fired, which is exactly one macrotask too late. Without
 * `busy`, checking a directory, clicking Adopt, then clicking Skip before the POST
 * resolves fires `onComplete` immediately — the wizard advances and marks import done
 * while `StepImport` unmounts out from under the still-in-flight request, and nothing
 * ever tells the admin whether that directory was actually adopted.
 */
export function StepImport({ onComplete, pending, skippable }: SetupStepProps) {
  return (
    <div className="flex max-h-[70vh] flex-col space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Import</h2>
        <p className="text-sm text-slate-500">
          Homestead found these compose directories already on disk. Check the ones to bring under
          management — this only reads your files until you press Adopt.
        </p>
      </div>

      <AdoptPanel
        onAllAdopted={onComplete}
        disabled={pending}
        showComposeFile
        actions={(busy) =>
          skippable && (
            <button
              type="button"
              onClick={onComplete}
              disabled={pending || busy}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
            >
              Skip
            </button>
          )
        }
      />
    </div>
  );
}
