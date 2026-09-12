import { DialogShell } from "@web/components/DialogShell";
import { AdoptPanel } from "@web/routes/AdoptPanel";

/**
 * Spec §8's "adopt from disk": scan the compose root for directories Homestead does not
 * know about yet, and let the admin multi-select which to take over.
 *
 * The backdrop, header, and focus handling (capture, initial focus, Tab trap,
 * restore-on-close) live in `DialogShell`, shared with `CreateAppDialog` (Task 5) since
 * both must behave identically there. Everything below the header — the scan listing,
 * selection, submission and partial-failure handling — lives in `AdoptPanel` (Task 6),
 * shared with the setup wizard's `StepImport`, which needs the identical behaviour
 * behind a Skip button instead of this dialog's Cancel.
 *
 * Leaves `AdoptPanel`'s `showComposeFile` at its default `false` deliberately: this
 * dialog's row content was Phase 1E's reviewed UI, and `StepImport`'s four-field
 * listing (spec §8/§9) was never specified for this dialog too.
 */
export function AdoptDialog({ onClose }: { onClose: () => void }) {
  return (
    <DialogShell title="Adopt from disk" onClose={onClose}>
      <AdoptPanel
        onAllAdopted={onClose}
        actions={() => (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
          >
            Cancel
          </button>
        )}
      />
    </DialogShell>
  );
}
