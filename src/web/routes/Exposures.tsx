import type { ExposureSummary } from "@shared/cloudflare.js";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  SegmentedControl,
  Spinner,
  StaleNotice,
} from "../components/ui/index.js";
import { ApiError } from "../lib/api.js";
import {
  type CloudflareStatus,
  isRefusal,
  useCloudflareStatus,
  useCreateExposure,
  useDeleteExposure,
  useExposures,
  useReconcileExposures,
  useUpdateExposure,
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

function ExposureDialog({
  open,
  onClose,
  exposure,
}: {
  open: boolean;
  onClose: () => void;
  exposure: ExposureSummary | null;
}) {
  const [hostname, setHostname] = useState("");
  const [label, setLabel] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [hostPort, setHostPort] = useState("");
  const [scheme, setScheme] = useState<"http" | "https">("https");
  const [enabled, setEnabled] = useState(true);
  const [accessEnabled, setAccessEnabled] = useState(true);
  const [noTlsVerify, setNoTlsVerify] = useState(false);
  const [pendingDisableAccess, setPendingDisableAccess] = useState(false);

  // Reset form when exposure changes or dialog opens
  useEffect(() => {
    if (open) {
      setHostname(exposure?.hostname ?? "");
      setLabel(exposure?.label ?? "");
      setProjectSlug(exposure?.projectSlug ?? "");
      setServiceName(exposure?.serviceName ?? "");
      setHostPort(exposure?.hostPort?.toString() ?? "");
      setScheme(exposure?.scheme ?? "https");
      setEnabled(exposure?.enabled ?? true);
      setAccessEnabled(exposure?.accessEnabled ?? true);
      setNoTlsVerify(exposure?.noTlsVerify ?? false);
      setPendingDisableAccess(false);
    }
  }, [open, exposure]);

  const create = useCreateExposure();
  const update = useUpdateExposure();
  const hostnameId = useId();
  const labelId = useId();
  const projectId = useId();
  const serviceId = useId();
  const portId = useId();

  const isEditing = exposure !== null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (isEditing) {
      // If disabling Access, show confirmation
      if (exposure.accessEnabled && !accessEnabled && !pendingDisableAccess) {
        setPendingDisableAccess(true);
        return;
      }

      try {
        await update.mutateAsync({
          id: exposure.id,
          enabled,
          accessEnabled,
          hostname: hostname !== exposure.hostname ? hostname : undefined,
          label: label !== exposure.label ? label || null : undefined,
        });
        onClose();
      } catch {
        // Error is handled by update.error
      }
    } else {
      try {
        await create.mutateAsync({
          projectSlug: projectSlug || null,
          serviceName: serviceName || null,
          hostPort: Number.parseInt(hostPort, 10),
          hostname,
          scheme,
          noTlsVerify,
          label: label || null,
          enabled,
          accessEnabled,
        });
        onClose();
      } catch {
        // Error is handled by create.error
      }
    }
  }

  function handleAccessToggle() {
    // When enabling Access, toggle immediately; when disabling, require confirmation
    if (accessEnabled) {
      setAccessEnabled(false);
    } else {
      setAccessEnabled(true);
      setPendingDisableAccess(false);
    }
  }

  function cancelDisableAccess() {
    setPendingDisableAccess(false);
    setAccessEnabled(true);
  }

  async function confirmDisableAccess() {
    if (!exposure) return;
    try {
      await update.mutateAsync({
        id: exposure.id,
        enabled,
        accessEnabled: false,
        hostname: hostname !== exposure.hostname ? hostname : undefined,
        label: label !== exposure.label ? label || null : undefined,
      });
      onClose();
    } catch {
      // Error is handled by update.error
      setPendingDisableAccess(false);
    }
  }

  if (pendingDisableAccess) {
    return (
      <Dialog
        open={open}
        onClose={cancelDisableAccess}
        title="Disable authentication?"
        role="alertdialog"
      >
        <p className="text-sm text-text mb-4">
          <strong className="font-medium">{hostname}</strong> will be accessible
          to anyone on the public internet who knows the URL. Are you sure you
          want to remove authentication?
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={cancelDisableAccess}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirmDisableAccess}>
            Remove authentication
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEditing ? "Edit exposure" : "Add exposure"}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor={hostnameId}
            className="block text-sm font-medium mb-1"
          >
            Hostname
          </label>
          <Input
            id={hostnameId}
            type="text"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="app.example.com"
            required
          />
        </div>

        {!isEditing && (
          <>
            <div>
              <label
                htmlFor={portId}
                className="block text-sm font-medium mb-1"
              >
                Port
              </label>
              <Input
                id={portId}
                type="number"
                value={hostPort}
                onChange={(e) => setHostPort(e.target.value)}
                placeholder="8080"
                required
              />
            </div>

            <div>
              <div className="block text-sm font-medium mb-1">Scheme</div>
              <SegmentedControl
                items={[
                  { id: "https", label: "HTTPS" },
                  { id: "http", label: "HTTP" },
                ]}
                value={scheme}
                onChange={(value) => setScheme(value as "http" | "https")}
              />
            </div>

            <div>
              <label
                htmlFor={projectId}
                className="block text-sm font-medium mb-1"
              >
                Project (optional)
              </label>
              <Input
                id={projectId}
                type="text"
                value={projectSlug}
                onChange={(e) => setProjectSlug(e.target.value)}
                placeholder="traefik"
              />
            </div>

            <div>
              <label
                htmlFor={serviceId}
                className="block text-sm font-medium mb-1"
              >
                Service (optional)
              </label>
              <Input
                id={serviceId}
                type="text"
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                placeholder="web"
              />
            </div>

            <div>
              <label className="flex items-center gap-2 min-h-11">
                <input
                  type="checkbox"
                  checked={noTlsVerify}
                  onChange={(e) => setNoTlsVerify(e.target.checked)}
                  className="min-h-[18px] min-w-[18px]"
                />
                <span className="text-sm">Skip TLS verification</span>
              </label>
            </div>
          </>
        )}

        <div>
          <label htmlFor={labelId} className="block text-sm font-medium mb-1">
            Label (optional)
          </label>
          <Input
            id={labelId}
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Public API"
          />
        </div>

        <div>
          <label className="flex items-center gap-2 min-h-11">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="min-h-[18px] min-w-[18px]"
            />
            <span className="text-sm">Enabled</span>
          </label>
        </div>

        <div>
          <label className="flex items-center gap-2 min-h-11">
            <input
              type="checkbox"
              checked={accessEnabled}
              onChange={handleAccessToggle}
              className="min-h-[18px] min-w-[18px]"
              aria-label="Require authentication (Cloudflare Access)"
            />
            <span className="text-sm">
              Require authentication (Cloudflare Access)
            </span>
          </label>
        </div>

        {(create.error || update.error) && (
          <p role="alert" className="text-sm text-danger">
            {create.error instanceof Error
              ? create.error.message
              : update.error instanceof Error
                ? update.error.message
                : "Failed to save exposure"}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || update.isPending}>
            {create.isPending || update.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
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
