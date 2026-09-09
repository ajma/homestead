import type { MonitorType, UptimeWindow } from "@shared/monitoring.js";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { HistoryBar } from "../components/HistoryBar.js";
import { MonitorEditor } from "../components/MonitorEditor.js";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Spinner,
  StaleNotice,
} from "../components/ui/index.js";
import { monitorLabel } from "../lib/monitor-labels.js";
import type { DeviceDetailData } from "../lib/queries.js";
import {
  isRefusal,
  useCreateMonitor,
  useDeleteMonitor,
  useDeviceDetail,
  useUpdateMonitor,
} from "../lib/queries.js";

const WINDOW_LABELS: Record<number, string> = {
  86400000: "24h",
  604800000: "7d",
  2592000000: "30d",
};

function formatUptime(window: UptimeWindow): string {
  const label = WINDOW_LABELS[window.windowMs] ?? `${window.windowMs}ms`;
  if (window.ratio === null) return `${label}: no data`;
  return `${label}: ${Math.round(window.ratio * 100)}%`;
}

/**
 * What each monitor type needs before it can run.
 *
 * The dialog used to collect a type and nothing else, so the request was
 * rejected outright — and had it succeeded, the monitor would have been saved
 * with an empty config and reported down forever on a validation error rather
 * than on anything about the device. The fields here are the ones each
 * executor's schema demands.
 */
const CONFIG_FIELDS: Record<
  MonitorType,
  {
    name: string;
    label: string;
    type: "text" | "number";
    placeholder?: string;
  }[]
> = {
  tcp: [
    { name: "host", label: "Host", type: "text", placeholder: "192.168.1.10" },
    { name: "port", label: "Port", type: "number", placeholder: "22" },
  ],
  http: [
    {
      name: "url",
      label: "URL",
      type: "text",
      placeholder: "http://192.168.1.10",
    },
  ],
  dns: [
    {
      name: "hostname",
      label: "Hostname",
      type: "text",
      placeholder: "nas.example.com",
    },
  ],
  push: [
    {
      name: "graceSeconds",
      label: "Grace period (seconds)",
      type: "number",
      placeholder: "300",
    },
  ],
  // The device being edited is the device being watched, so there is nothing
  // to ask: `deviceId` is filled from the route.
  tailscale: [],
  reachability: [],
  docker: [],
};

function AddMonitorDialog({
  open,
  onClose,
  onSubmit,
  deviceId,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (
    type: MonitorType,
    config: Record<string, string | number>,
  ) => Promise<void>;
  deviceId: string;
}) {
  const [type, setType] = useState<MonitorType>("tcp");
  const [values, setValues] = useState<Record<string, string>>({});
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = CONFIG_FIELDS[type] ?? [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsPending(true);
    try {
      const config: Record<string, string | number> =
        type === "tailscale" ? { deviceId } : {};
      for (const field of fields) {
        const raw = values[field.name] ?? "";
        config[field.name] = field.type === "number" ? Number(raw) : raw;
      }
      await onSubmit(type, config);
      onClose();
      setType("tcp");
      setValues({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add monitor");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add Monitor">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="type" className="block text-sm font-medium mb-1">
            Type
          </label>
          <select
            id="type"
            value={type}
            onChange={(e) => setType(e.target.value as MonitorType)}
            className="h-11 w-full rounded-md border border-border bg-surface px-3 text-sm"
            required
          >
            {(["tcp", "http", "dns", "push", "tailscale"] as const).map((t) => (
              <option key={t} value={t}>
                {monitorLabel(t)}
              </option>
            ))}
          </select>
        </div>
        {fields.map((field) => (
          <div key={field.name}>
            <label
              htmlFor={`cfg-${field.name}`}
              className="block text-sm font-medium mb-1"
            >
              {field.label}
            </label>
            <input
              id={`cfg-${field.name}`}
              type={field.type}
              value={values[field.name] ?? ""}
              placeholder={field.placeholder}
              onChange={(e) =>
                setValues((v) => ({ ...v, [field.name]: e.target.value }))
              }
              className="h-11 w-full rounded-md border border-border bg-surface px-3 text-sm"
              required
            />
          </div>
        ))}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isPending } = useDeviceDetail(id ?? "");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const createMonitor = useCreateMonitor(id ?? "");
  const updateMonitor = useUpdateMonitor(id ?? "");
  const deleteMonitor = useDeleteMonitor(id ?? "");

  async function handleAddMonitor(
    type: MonitorType,
    config: Record<string, string | number>,
  ) {
    await createMonitor.mutateAsync({ type, config });
  }

  function handleToggleRequired(monitorId: string, required: boolean) {
    updateMonitor.mutate({ id: monitorId, required });
  }

  function handleDelete(monitorId: string) {
    deleteMonitor.mutate(monitorId);
  }

  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-8">
      <Body
        data={data}
        error={error}
        isPending={isPending}
        onOpenAddDialog={() => setAddDialogOpen(true)}
        onToggleRequired={handleToggleRequired}
        onDelete={handleDelete}
      />
      <AddMonitorDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onSubmit={handleAddMonitor}
        deviceId={id ?? ""}
      />
    </main>
  );
}

function Body({
  data,
  error,
  isPending,
  onOpenAddDialog,
  onToggleRequired,
  onDelete,
}: {
  data: DeviceDetailData | null | undefined;
  error: Error | null;
  isPending: boolean;
  onOpenAddDialog: () => void;
  onToggleRequired: (id: string, required: boolean) => void;
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
          description="Viewing device details needs an administrator account. Ask an administrator to grant you access."
        />
      );
    return (
      <p role="alert" className="mt-6 text-sm text-danger">
        Could not load device. {error.message}
      </p>
    );
  }

  if (!data) return null;

  return (
    <>
      {error && <StaleNotice className="mt-4" />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">{data.device.name}</h1>
        <Badge>{data.device.kind}</Badge>
      </div>

      <section className="mt-6">
        <h2 className="text-lg font-semibold mb-3">Uptime</h2>
        <div className="flex gap-4 text-sm">
          {data.uptime.map((window) => (
            <div key={window.windowMs}>
              <span className="text-muted">{formatUptime(window)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-semibold mb-3">History (24h)</h2>
        <HistoryBar buckets={data.history} />
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Monitors</h2>
          <Button onClick={onOpenAddDialog}>Add Monitor</Button>
        </div>
        {data.monitors.length === 0 ? (
          <EmptyState
            title="No monitors"
            description="Add a monitor to track this device's availability."
            action={<Button onClick={onOpenAddDialog}>Add Monitor</Button>}
          />
        ) : (
          <MonitorEditor
            monitors={data.monitors}
            onToggleRequired={onToggleRequired}
            onDelete={onDelete}
          />
        )}
      </section>
    </>
  );
}
