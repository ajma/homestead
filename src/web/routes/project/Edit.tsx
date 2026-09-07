import { useState } from "react";
import { useParams } from "react-router-dom";
import { ComposeEditor } from "../../components/ComposeEditor.js";
import { EnvEditor } from "../../components/EnvEditor.js";
import {
  Button,
  Dialog,
  SegmentedControl,
  Spinner,
} from "../../components/ui/index.js";
import {
  isRefusal,
  useProjectFile,
  useSaveProjectFile,
} from "../../lib/queries.js";
import { useUnsavedChanges } from "../../lib/useUnsavedChanges.js";

type Which = "compose" | "env";

const FILES = [
  { id: "compose", label: "Compose" },
  { id: "env", label: ".env" },
];

/**
 * The Edit tab: the compose file and the `.env`, one buffer each.
 *
 * A buffer is only ever compared against what the server last returned, and is
 * never cleared on save. That is what makes "dirty" survive the refetch a save
 * triggers without flickering back to the old text for a frame, and it means
 * the Save button turns itself off when — and only when — the file on disk
 * matches what is on screen.
 */
export function Edit() {
  const { slug = "" } = useParams();
  const [which, setWhich] = useState<Which>("compose");
  // `undefined` means untouched, so the server's copy is what is shown. For
  // `.env`, `null` from the server means the file does not exist yet, which is
  // a state the empty buffer `""` is deliberately distinct from: creating an
  // empty `.env` is a real, savable change.
  const [buffers, setBuffers] = useState<{
    compose?: string;
    env?: string;
  }>({});
  const [pendingSwitch, setPendingSwitch] = useState<Which | null>(null);

  const compose = useProjectFile(slug, "compose");
  const env = useProjectFile(slug, "env");
  const saveCompose = useSaveProjectFile(slug, "compose");
  const saveEnv = useSaveProjectFile(slug, "env");

  const serverCompose = compose.data?.content ?? "";
  const serverEnv = env.data ? env.data.content : null;

  const composeValue = buffers.compose ?? serverCompose;
  const envValue = buffers.env ?? serverEnv;

  const composeDirty =
    buffers.compose !== undefined && buffers.compose !== serverCompose;
  const envDirty = buffers.env !== undefined && buffers.env !== serverEnv;
  const dirty = composeDirty || envDirty;

  // Router-level: a Link, the back arrow or a typed URL.
  const guard = useUnsavedChanges(dirty);

  const activeDirty = which === "compose" ? composeDirty : envDirty;

  /**
   * The router never sees this one. Both editors live under the `edit` route,
   * so switching between them is in-page state — and it drops the buffer for
   * the file being left, exactly as leaving the route does. Silently losing a
   * half-written `.env` because someone tapped "Compose" is the failure this
   * prevents; asking makes the two kinds of "leaving" behave the same.
   */
  function requestSwitch(next: Which) {
    if (next === which) return;
    if (activeDirty) {
      setPendingSwitch(next);
      return;
    }
    setWhich(next);
  }

  function discardAndSwitch() {
    const next = pendingSwitch;
    if (!next) return;
    setBuffers((b) => ({ ...b, [which]: undefined }));
    setWhich(next);
    setPendingSwitch(null);
  }

  if (compose.isPending || env.isPending)
    return (
      <div className="flex justify-center py-12 text-muted">
        <Spinner />
      </div>
    );

  const loadError = compose.error ?? env.error;
  if (loadError)
    return (
      <p role="alert" className="text-sm text-danger">
        {isRefusal(loadError)
          ? "Editing a project needs an administrator account."
          : `Could not load the project's files. ${loadError.message}`}
      </p>
    );

  const saving = which === "compose" ? saveCompose : saveEnv;

  return (
    <section className="flex flex-col gap-3" aria-label="Edit project files">
      <div>
        <SegmentedControl
          items={FILES}
          value={which}
          onChange={(v) => requestSwitch(v === "env" ? "env" : "compose")}
        />
      </div>

      {which === "compose" ? (
        <ComposeEditor
          slug={slug}
          value={composeValue}
          onChange={(next) => setBuffers((b) => ({ ...b, compose: next }))}
          onSave={() => saveCompose.mutate(composeValue)}
          dirty={composeDirty}
        />
      ) : (
        <EnvEditor
          value={envValue}
          onChange={(next) => setBuffers((b) => ({ ...b, env: next }))}
          // `envValue` is only null while the file does not exist, and the
          // Save button is unreachable in that state, so `?? ""` is a type
          // narrowing rather than a behaviour.
          onSave={() => saveEnv.mutate(envValue ?? "")}
          dirty={envDirty}
        />
      )}

      {saving.isError && (
        <p role="alert" className="text-sm text-danger">
          Could not save. {saving.error.message}
        </p>
      )}
      {saving.isSuccess && !activeDirty && (
        <p role="status" className="text-sm text-muted">
          Saved.
        </p>
      )}

      {/* One dialog, two callers: leaving the route and leaving the file.
          Both mean "abandon this buffer", so both ask the same question. */}
      <DiscardDialog
        open={guard.blocked}
        onKeep={guard.cancel}
        onDiscard={guard.proceed}
        what="leave the editor"
      />
      <DiscardDialog
        open={pendingSwitch !== null}
        onKeep={() => setPendingSwitch(null)}
        onDiscard={discardAndSwitch}
        what={
          pendingSwitch === "env"
            ? "switch to .env"
            : "switch to the compose file"
        }
      />
    </section>
  );
}

function DiscardDialog({
  open,
  onKeep,
  onDiscard,
  what,
}: {
  open: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  what: string;
}) {
  if (!open) return null;
  return (
    <Dialog
      open
      onClose={onKeep}
      title="Discard unsaved changes?"
      role="alertdialog"
    >
      <p className="text-sm text-text">
        You have edits that have not been written to disk. If you {what} now,
        they are lost.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {/* Keeping is first and is the default focus: the safe answer should
            be the one a mis-tap lands on. */}
        <Button onClick={onKeep}>Keep editing</Button>
        <Button variant="danger" onClick={onDiscard}>
          Discard changes
        </Button>
      </div>
    </Dialog>
  );
}
