import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api.js";
import { type ProjectDetailData, useDeleteProject } from "../lib/queries.js";
import { Button, Dialog, Input } from "./ui/index.js";

/**
 * Confirmation for `DELETE /api/projects/:slug`.
 *
 * Three things this has to get right, none of them cosmetic:
 *
 * 1. **The slug is typed, not clicked.** Deleting a directory is the one
 *    irreversible action in the app, and a mis-tap on a phone must not be able
 *    to reach it.
 * 2. **Adopted projects are asked twice.** Absence of the `x-homestead` block
 *    means Homestead did not create this directory — someone else did, which
 *    makes it the case likeliest to hold something they care about. That is the
 *    whole reason the provenance marker is worth reading (§3.7).
 * 3. **Named volumes are named.** The server runs `down` with no volume flag,
 *    so the data survives the delete and the user is the only one who can
 *    remove it. Telling them the volume exists without telling them the command
 *    would leave them hunting through `docker volume ls` for a name they no
 *    longer have a project to look it up from. Deleting them for the user is
 *    deferred (§8) precisely because it cannot be undone.
 */
export function DeleteProjectDialog({
  open,
  onClose,
  detail,
}: {
  /**
   * Mount this component only while it is open — `ProjectDetail` does.
   *
   * The typed slug and the "already said yes once" flag are local state, and
   * reopening must not resume a half-finished confirmation: someone who
   * escaped out of the second prompt has said no, and must be asked from the
   * start. Unmounting is what guarantees that, rather than an effect that has
   * to remember to clear each new piece of state added later.
   */
  open: boolean;
  onClose: () => void;
  detail: ProjectDetailData;
}) {
  const navigate = useNavigate();
  const remove = useDeleteProject();
  const [typed, setTyped] = useState("");
  const [confirmedOnce, setConfirmedOnce] = useState(false);
  const nameId = useId();
  const descId = useId();

  const slug = detail.slug;
  // Absence of x-homestead IS the provenance marker.
  const adopted = !detail.hasHomestead;
  // `external: true` volumes are owned elsewhere — another stack, or the
  // operator by hand — so they must never be offered or even implied here.
  const orphans = detail.model?.volumes.filter((v) => !v.external) ?? [];

  const matches = typed === slug;
  const finalStep = confirmedOnce || !adopted;

  async function confirm() {
    // The real gate, not a mirror of the `disabled` prop. `disabled` stops a
    // pointer; this stops everything else — a keyboard activation racing a
    // re-render, or a second click delivered against the previous frame.
    if (!matches) return;
    if (adopted && !confirmedOnce) {
      setConfirmedOnce(true);
      // Clearing the field is half of what stops a double-tap walking through
      // both confirmations in one gesture: without it the slug is already
      // satisfied when step two mounts, so the second click of a dblClick
      // deletes. The other half is the `key` on the button below.
      setTyped("");
      return;
    }
    try {
      await remove.mutateAsync(slug);
    } catch {
      // The dialog stays open and says so; the message is rendered below.
      return;
    }
    onClose();
    navigate("/projects");
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        confirmedOnce ? `Really delete ${slug}?` : `Delete ${slug} for good?`
      }
      describedBy={descId}
      role="alertdialog"
    >
      <div id={descId} className="flex flex-col gap-3 text-sm text-text">
        {confirmedOnce ? (
          <p role="alert">
            Homestead did not create <strong>{slug}</strong>, so this directory
            and everything in it came from somewhere else. Deleting it removes
            the whole directory from disk. This cannot be undone.
          </p>
        ) : (
          <>
            <p>
              This stops the stack, removes its containers and networks, and
              deletes the directory <strong>{slug}</strong> and every file in
              it. This cannot be undone.
            </p>
            {adopted && (
              <p className="text-warning">
                Homestead did not create this project — it was already on disk
                when Homestead found it. You will be asked to confirm twice.
              </p>
            )}
          </>
        )}

        {orphans.length > 0 && (
          <div className="rounded-md border border-border bg-surface p-3">
            <p className="font-medium">
              {orphans.length === 1
                ? "One named volume is left behind"
                : `${orphans.length} named volumes are left behind`}
            </p>
            <p className="mt-1 text-muted">
              Homestead never deletes volume data. Remove them by hand if you
              want the data gone:
            </p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-muted text-xs">
              {orphans.map((v) => `docker volume rm ${v.name}`).join("\n")}
            </pre>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-muted">
            Type <strong className="text-text">{slug}</strong> to confirm
          </label>
          <Input
            id={nameId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            // Enter is what a person does after typing a name into a field,
            // and there is no <form> here to do it for them. It also makes
            // `confirm`'s own `!matches` check load-bearing rather than
            // decorative: this path never consults the button's `disabled`,
            // so the guard in the handler is the only thing stopping a
            // near-miss from deleting the project.
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              void confirm();
            }}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        {remove.isError && (
          <p role="alert" className="text-danger">
            {/* A 409 here is not a failure to explain away: something is
                running against this project right now — an `up` from another
                tab — and the delete was refused so it cannot race it. "409
                operation_in_progress" would tell the user nothing about what
                to do, which is wait. */}
            {remove.error instanceof ApiError && remove.error.status === 409
              ? `Another operation is running for ${slug}. Wait for it to finish, then try again.`
              : `Could not delete this project. ${remove.error.message}`}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button
            // A distinct key per step, so React unmounts "Continue" and mounts
            // a *new* element for "Delete project" rather than relabelling the
            // node already under the user's finger. Without it a single
            // dblClick delivers its second event to the same button, which by
            // then is the final confirm — one gesture through both
            // confirmations, on exactly the projects the second one protects.
            key={finalStep ? "confirm-final" : "confirm-continue"}
            variant="danger"
            // Disabled until the slug is typed exactly — on both steps, and
            // advancing clears the field, so the final confirm starts locked.
            disabled={!matches || remove.isPending}
            loading={remove.isPending}
            onClick={confirm}
          >
            {finalStep ? "Delete project" : "Continue"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
