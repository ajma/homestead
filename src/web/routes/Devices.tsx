import type { DeviceSummary } from "@shared/monitoring.js";
import { useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  SegmentedControl,
  Spinner,
  StaleNotice,
  StatusDot,
} from "../components/ui/index.js";
import {
  isRefusal,
  useConfigureTailscale,
  useDevices,
} from "../lib/queries.js";

const ROW =
  "flex min-h-11 w-full items-center gap-3 px-4 py-2 text-sm text-text";

function formatRelativeTime(timestamp: number | null): string {
  if (timestamp === null) return "never";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function DeviceRow({ device }: { device: DeviceSummary }) {
  const tailscaleState =
    device.connectedToControl === true
      ? "connected"
      : formatRelativeTime(device.lastSeen);

  return (
    <li className={ROW}>
      <StatusDot state={device.status.state} />
      <span className="min-w-0 flex-1 truncate font-medium">{device.name}</span>
      <Badge>{device.kind}</Badge>
      {device.os && <span className="text-muted">{device.os}</span>}
      <span className="text-muted">{tailscaleState}</span>
    </li>
  );
}

function TailscaleSettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [tailnet, setTailnet] = useState("");
  const [token, setToken] = useState("");
  const [success, setSuccess] = useState<string | null>(null);
  const configure = useConfigureTailscale();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSuccess(null);
    try {
      const result = await configure.mutateAsync({ tailnet, token });
      setSuccess(
        `Configured successfully. Found ${result.deviceCount} device${result.deviceCount === 1 ? "" : "s"}.`,
      );
      setTailnet("");
      setToken("");
      setTimeout(() => onClose(), 2000);
    } catch {
      // Error is handled by configure.error
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Configure Tailscale">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="tailnet" className="block text-sm font-medium mb-1">
            Tailnet
          </label>
          <Input
            id="tailnet"
            type="text"
            value={tailnet}
            onChange={(e) => setTailnet(e.target.value)}
            placeholder="example.ts.net"
            required
          />
        </div>
        <div>
          <label htmlFor="token" className="block text-sm font-medium mb-1">
            API Token
          </label>
          <Input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="tskey-..."
            required
          />
        </div>
        {configure.error && (
          <p role="alert" className="text-sm text-danger">
            {configure.error instanceof Error
              ? configure.error.message
              : "Failed to configure Tailscale"}
          </p>
        )}
        {success && <p className="text-sm text-success">{success}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button type="submit" disabled={configure.isPending}>
            {configure.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function Devices() {
  const { data, error, isPending } = useDevices();
  const [showHidden, setShowHidden] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">Devices</h1>
      </div>
      <Body
        data={data}
        error={error}
        isPending={isPending}
        showHidden={showHidden}
        onShowHiddenChange={setShowHidden}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <TailscaleSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </main>
  );
}

function Body({
  data,
  error,
  isPending,
  showHidden,
  onShowHiddenChange,
  onOpenSettings,
}: {
  data: DeviceSummary[] | undefined;
  error: Error | null;
  isPending: boolean;
  showHidden: boolean;
  onShowHiddenChange: (show: boolean) => void;
  onOpenSettings: () => void;
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
          description="Viewing devices needs an administrator account. Ask an administrator to grant you access."
        />
      );
    return (
      <p role="alert" className="mt-6 text-sm text-danger">
        Could not load devices. {error.message}
      </p>
    );
  }

  if (!data) return null;

  return (
    <>
      {error && <StaleNotice className="mt-4" />}
      {data.length === 0 ? (
        <EmptyState
          title="No devices yet"
          description="Configure your Tailscale API token to discover devices from your tailnet."
          action={<Button onClick={onOpenSettings}>Configure Tailscale</Button>}
        />
      ) : (
        <>
          <div className="mt-4 flex items-center justify-between">
            <SegmentedControl
              items={[
                { id: "active", label: "Active" },
                { id: "all", label: "All" },
              ]}
              value={showHidden ? "all" : "active"}
              onChange={(value) => onShowHiddenChange(value === "all")}
            />
          </div>
          <ul className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
            {data
              .filter((device) => showHidden || !device.hidden)
              .map((device) => (
                <DeviceRow key={device.id} device={device} />
              ))}
          </ul>
        </>
      )}
    </>
  );
}
