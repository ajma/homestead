import type { ExposureSummary } from "@shared/cloudflare.js";
import type { PublishedPort } from "@shared/projects.js";
import { useEffect, useId, useState } from "react";
import { composeHostname, splitHostname } from "../lib/hostname.js";
import {
  useCreateExposure,
  useUpdateExposure,
  useZones,
} from "../lib/queries.js";
import { Button, Dialog, Input, SegmentedControl } from "./ui/index.js";

/** A published port offered in the picker, with the service that owns it. */
export type PortOption = PublishedPort & { service: string };

export function ExposureDialog({
  open,
  onClose,
  exposure,
  projectSlug: fixedProject,
  ports,
  initialPort,
}: {
  open: boolean;
  onClose: () => void;
  exposure: ExposureSummary | null;
  /** Set when opened from a project: the exposure belongs to it. */
  projectSlug?: string;
  /** That project's published ports. Given these, the port becomes a picker. */
  ports?: PortOption[];
  /** Preselected in that picker — the port whose Expose… button was clicked. */
  initialPort?: number;
}) {
  const [hostLabel, setHostLabel] = useState("");
  const [selectedZone, setSelectedZone] = useState("");
  const [label, setLabel] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [hostPort, setHostPort] = useState("");
  const [scheme, setScheme] = useState<"http" | "https">("http");
  const [enabled, setEnabled] = useState(true);
  const [accessEnabled, setAccessEnabled] = useState(true);
  const [noTlsVerify, setNoTlsVerify] = useState(false);
  const [pendingDisableAccess, setPendingDisableAccess] = useState(false);
  const zones = useZones();

  // Reset form when exposure changes or dialog opens. Depends on the zone
  // list: an existing hostname cannot be split into label and zone until the
  // zones have arrived, so this runs again when they do.
  useEffect(() => {
    if (open) {
      const split = splitHostname(exposure?.hostname ?? "", zones.data ?? []);
      setHostLabel(split.label);
      setSelectedZone(
        zones.data?.find((z) => z.id === split.zoneId)?.name ?? "",
      );
      setLabel(exposure?.label ?? "");
      setProjectSlug(exposure?.projectSlug ?? fixedProject ?? "");
      setHostPort(
        exposure?.hostPort?.toString() ?? initialPort?.toString() ?? "",
      );
      setScheme(exposure?.scheme ?? "http");
      setEnabled(exposure?.enabled ?? true);
      setAccessEnabled(exposure?.accessEnabled ?? true);
      setNoTlsVerify(exposure?.noTlsVerify ?? false);
      setPendingDisableAccess(false);
    }
  }, [open, exposure, zones.data, fixedProject, initialPort]);

  const create = useCreateExposure();
  const update = useUpdateExposure();
  const hostnameId = useId();
  const zoneId = useId();
  const labelId = useId();
  const projectId = useId();
  const portId = useId();

  const isEditing = exposure !== null;
  const fullHostname = composeHostname(hostLabel, selectedZone);

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
          // Only when it actually resolves to something. Zones may still be
          // loading, or the exposure's zone may have been removed from the
          // account, and "" would erase a working hostname.
          hostname:
            fullHostname && fullHostname !== exposure.hostname
              ? fullHostname
              : undefined,
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
          hostPort: Number.parseInt(hostPort, 10),
          hostname: fullHostname,
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
        hostname:
          fullHostname && fullHostname !== exposure.hostname
            ? fullHostname
            : undefined,
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
          <strong className="font-medium">{fullHostname}</strong> will be
          accessible to anyone on the public internet who knows the URL. Are you
          sure you want to remove authentication?
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
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <label
              htmlFor={hostnameId}
              className="block text-sm font-medium mb-1"
            >
              Name
            </label>
            <Input
              id={hostnameId}
              type="text"
              value={hostLabel}
              onChange={(e) => setHostLabel(e.target.value)}
              placeholder="metube"
            />
          </div>
          <div className="min-w-0 flex-1">
            <label htmlFor={zoneId} className="block text-sm font-medium mb-1">
              Domain
            </label>
            <select
              id={zoneId}
              value={selectedZone}
              onChange={(e) => setSelectedZone(e.target.value)}
              className="min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text"
              required={!isEditing}
            >
              <option value="">Choose…</option>
              {zones.data?.map((z) => (
                <option key={z.id} value={z.name}>
                  {z.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted">
          {fullHostname ? (
            <>
              Will be published at{" "}
              <strong className="text-text">{`https://${fullHostname}`}</strong>
              . Leave the name empty to use the domain itself.
            </>
          ) : (
            "Choose a domain. Homestead creates the DNS record for it."
          )}
        </p>

        {!isEditing && (
          <>
            <div>
              <label
                htmlFor={portId}
                className="block text-sm font-medium mb-1"
              >
                Port
              </label>
              {ports ? (
                <select
                  id={portId}
                  value={hostPort}
                  onChange={(e) => setHostPort(e.target.value)}
                  className="min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text"
                  required
                >
                  <option value="">Choose a port…</option>
                  {ports.map((p) => (
                    <option
                      key={`${p.hostIp}:${p.hostPort}/${p.protocol}`}
                      value={String(p.hostPort)}
                    >
                      {p.hostPort} — {p.service}
                      {p.loopbackOnly ? " (loopback only)" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id={portId}
                  type="number"
                  value={hostPort}
                  onChange={(e) => setHostPort(e.target.value)}
                  placeholder="8080"
                  required
                />
              )}
              <p className="mt-1 text-xs text-muted">
                The port the service already listens on <em>on this machine</em>
                . The same number you would use in{" "}
                <code>http://localhost:…</code> here. Not the public port —
                visitors always arrive on 443.
              </p>
            </div>

            <div>
              <div className="block text-sm font-medium mb-1">
                Origin scheme
              </div>
              <SegmentedControl
                items={[
                  { id: "http", label: "HTTP" },
                  { id: "https", label: "HTTPS" },
                ]}
                value={scheme}
                onChange={(value) => setScheme(value as "http" | "https")}
              />
              <p className="mt-1 text-xs text-muted">
                How the tunnel reaches the service locally, not how visitors
                reach you — that is always HTTPS. Most self-hosted apps speak
                plain HTTP on their port, so leave this on HTTP unless the app
                serves HTTPS itself.
              </p>
            </div>

            {/* Opened from a project, the answer is already known — asking
                again only invites a typo that detaches the exposure. */}
            {fixedProject === undefined && (
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
                <p className="mt-1 text-xs text-muted">
                  The slug of the Homestead project behind this port, if there
                  is one. Leave empty for anything Homestead does not run — a
                  NAS admin page, a printer, a service started by hand.
                </p>
              </div>
            )}

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
              <p className="mt-1 text-xs text-muted">
                Only for an HTTPS origin with a self-signed certificate — Unifi
                and Proxmox are the usual ones. The tunnel refuses those by
                default. Irrelevant when the origin scheme is HTTP.
              </p>
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
