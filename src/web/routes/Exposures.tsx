import type { ExposureSummary } from "@shared/cloudflare.js";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ExposureDialog } from "../components/ExposureDialog.js";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Spinner,
  StaleNotice,
} from "../components/ui/index.js";
import { ApiError } from "../lib/api.js";
import {
  type CloudflareStatus,
  isRefusal,
  useCloudflareStatus,
  useDeleteExposure,
  useExposures,
  useReconcileExposures,
} from "../lib/queries.js";

const ROW =
  "flex min-h-11 w-full items-center gap-3 px-4 py-2 text-sm text-text";

function ExposureRow({
  exposure,
  onEdit,
  onDelete,
}: {
  exposure: ExposureSummary;
  onEdit: (exposure: ExposureSummary) => void;
  onDelete: (id: string) => void;
}) {
  const serviceLabel = exposure.label
    ? exposure.label
    : exposure.projectSlug && exposure.serviceName
      ? `${exposure.projectSlug} / ${exposure.serviceName}`
      : `Port ${exposure.hostPort}`;

  return (
    <li className={ROW}>
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{exposure.hostname}</div>
        <div className="text-muted text-xs truncate">{serviceLabel}</div>
      </div>
      {exposure.accessEnabled && <Badge>Access</Badge>}
      {!exposure.enabled && <Badge>Disabled</Badge>}
      <Button
        variant="ghost"
        onClick={() => onEdit(exposure)}
        aria-label={`Edit ${exposure.hostname}`}
      >
        Edit
      </Button>
      <Button
        variant="ghost"
        onClick={() => onDelete(exposure.id)}
        aria-label={`Delete ${exposure.hostname}`}
      >
        Delete
      </Button>
    </li>
  );
}

function ConflictDialog({
  open,
  onClose,
  error,
  onAdopt,
  onOverwrite,
}: {
  open: boolean;
  onClose: () => void;
  error: ApiError | null;
  onAdopt: () => void;
  onOverwrite: () => void;
}) {
  if (!error) return null;

  return (
    <Dialog open={open} onClose={onClose} title="Tunnel configuration conflict">
      <p className="text-sm text-text mb-4">
        {error.detail ||
          "The tunnel has been modified outside Homestead. You can adopt the current configuration or overwrite it with Homestead's settings."}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="ghost" onClick={onAdopt}>
          Adopt
        </Button>
        <Button variant="danger" onClick={onOverwrite}>
          Overwrite
        </Button>
      </div>
    </Dialog>
  );
}

export function Exposures() {
  const { data, error, isPending } = useExposures();
  const {
    data: status,
    error: statusError,
    isPending: statusPending,
  } = useCloudflareStatus();
  const [editingExposure, setEditingExposure] =
    useState<ExposureSummary | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [conflictError, setConflictError] = useState<ApiError | null>(null);
  const deleteExposure = useDeleteExposure();
  const reconcile = useReconcileExposures();

  function handleEdit(exposure: ExposureSummary) {
    setEditingExposure(exposure);
    setShowDialog(true);
  }

  function handleAdd() {
    setEditingExposure(null);
    setShowDialog(true);
  }

  function handleCloseDialog() {
    setShowDialog(false);
    setEditingExposure(null);
  }

  async function handleDelete(id: string) {
    if (confirm("Delete this exposure?")) {
      await deleteExposure.mutateAsync(id);
    }
  }

  async function handleReconcile() {
    try {
      await reconcile.mutateAsync();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflictError(err);
      }
      // Other errors are shown via reconcile.error
    }
  }

  function handleAdopt() {
    // TODO: implement adopt endpoint when available
    setConflictError(null);
  }

  function handleOverwrite() {
    // TODO: implement overwrite endpoint when available
    setConflictError(null);
  }

  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">Exposures</h1>
        {status?.configured && (
          <div className="flex gap-2">
            <Button onClick={handleReconcile} disabled={reconcile.isPending}>
              {reconcile.isPending ? "Reconciling..." : "Reconcile"}
            </Button>
            <Button onClick={handleAdd}>Add exposure</Button>
          </div>
        )}
      </div>

      {reconcile.error && !conflictError && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {reconcile.error instanceof Error
            ? reconcile.error.message
            : "Failed to reconcile"}
        </p>
      )}

      <Body
        data={data}
        error={error}
        isPending={isPending}
        statusData={status}
        statusError={statusError}
        statusPending={statusPending}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />

      <ExposureDialog
        open={showDialog}
        onClose={handleCloseDialog}
        exposure={editingExposure}
      />

      <ConflictDialog
        open={conflictError !== null}
        onClose={() => setConflictError(null)}
        error={conflictError}
        onAdopt={handleAdopt}
        onOverwrite={handleOverwrite}
      />
    </main>
  );
}

function Body({
  data,
  error,
  isPending,
  statusData,
  statusError,
  statusPending,
  onEdit,
  onDelete,
}: {
  data: ExposureSummary[] | undefined;
  error: Error | null;
  isPending: boolean;
  statusData: CloudflareStatus | null | undefined;
  statusError: Error | null;
  statusPending: boolean;
  onEdit: (exposure: ExposureSummary) => void;
  onDelete: (id: string) => void;
}) {
  if (isPending)
    return (
      <div className="flex justify-center py-12 text-muted">
        <Spinner />
      </div>
    );

  if (error && !data) {
    if (isRefusal(error))
      return (
        <EmptyState
          title="You do not have access"
          description="Managing exposures needs an administrator account. Ask an administrator to grant you access."
        />
      );
    return (
      <p role="alert" className="mt-6 text-sm text-danger">
        Could not load exposures. {error.message}
      </p>
    );
  }

  if (!data) return null;

  return (
    <>
      {error && <StaleNotice className="mt-4" />}
      {data.length === 0 ? (
        statusPending ? (
          <div className="flex justify-center py-12 text-muted">
            <Spinner />
          </div>
        ) : statusError || !statusData ? (
          <EmptyState
            title="No exposures yet"
            description="Add an exposure to publish a local service at a public hostname. Could not verify Cloudflare configuration status."
          />
        ) : statusData.configured ? (
          <EmptyState
            title="No exposures yet"
            description="Add an exposure to publish a local service at a public hostname."
          />
        ) : (
          <EmptyState
            title="Cloudflare Tunnel is not configured yet"
            description="Set up Cloudflare Tunnel to publish services securely."
            action={
              <Link to="/cloudflare/setup">
                <Button>Configure Cloudflare</Button>
              </Link>
            }
          />
        )
      ) : (
        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {data.map((exposure) => (
            <ExposureRow
              key={exposure.id}
              exposure={exposure}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </>
  );
}
