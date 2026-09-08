import type { ExposureSummary } from "@shared/cloudflare.js";
import type { Operation, PublishedPort } from "@shared/projects.js";
import type { ReactNode } from "react";
import type { PortOption } from "../../components/ExposureDialog.js";
import {
  Badge,
  Button,
  Panel,
  Spinner,
  StatusDot,
} from "../../components/ui/index.js";
import {
  isRefusal,
  type ProjectDetailData,
  useProjectOperations,
} from "../../lib/queries.js";
import { dockerStateToStatus, formatDuration } from "./status.js";

/** The five most recent runs: this is a glance, not an audit log. */
const RECENT_LIMIT = 5;

/**
 * A titled panel that is also a landmark, so each block of the overview can be
 * found and skipped to by name rather than by position.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel title={title} role="region" aria-label={title}>
      {children}
    </Panel>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

function portLabel(port: PublishedPort): string {
  return `${port.hostIp}:${port.hostPort} → ${port.containerPort}/${port.protocol}`;
}

function Ports({
  ports,
  service,
  exposures,
  onExpose,
  onEditExposure,
}: {
  ports: PublishedPort[];
  service: string;
  exposures: ExposureSummary[];
  onExpose: (port: PortOption) => void;
  onEditExposure: (exposure: ExposureSummary) => void;
}) {
  if (ports.length === 0)
    return <p className="mt-1 text-sm text-muted">No published ports</p>;
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {ports.map((port) => {
        // Host ports are unique on a machine, so the port alone is a sound
        // join key. The caller has already narrowed these to this project —
        // an exposure recorded against another one is not ours to edit.
        const exposure = exposures.find((e) => e.hostPort === port.hostPort);
        return (
          <li
            key={`${port.hostIp}:${port.hostPort}/${port.protocol}`}
            className="flex flex-wrap items-center gap-2 text-sm text-muted"
          >
            <span className="font-mono text-xs">{portLabel(port)}</span>
            {/* The §7.4 distinction, stated rather than implied: a wildcard bind
              is reachable by every device on the LAN, a loopback bind is
              reachable only through the tunnel. */}
            {port.loopbackOnly ? (
              <Badge>tunnel-only</Badge>
            ) : (
              <Badge tone="warning">LAN</Badge>
            )}
            {exposure ? (
              <>
                <span className="truncate text-text">{exposure.hostname}</span>
                {exposure.accessEnabled && <Badge>Access</Badge>}
                <Button
                  variant="ghost"
                  onClick={() => onEditExposure(exposure)}
                  aria-label={`Edit ${exposure.hostname}`}
                >
                  Edit
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                onClick={() => onExpose({ ...port, service })}
                aria-label={`Expose port ${port.hostPort}`}
              >
                Expose…
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Services({
  detail,
  exposures,
  onExpose,
  onEditExposure,
}: {
  detail: ProjectDetailData;
  exposures: ExposureSummary[];
  onExpose: (port: PortOption) => void;
  onEditExposure: (exposure: ExposureSummary) => void;
}) {
  const byService = new Map(detail.states.map((s) => [s.service, s]));
  return (
    <Section title="Services">
      {detail.model === null ? (
        <Note>Unavailable until the compose file parses.</Note>
      ) : detail.model.services.length === 0 ? (
        <Note>This compose file declares no services.</Note>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {detail.model.services.map((service) => {
            const state = byService.get(service.name);
            return (
              <li key={service.name} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/* A service name is an identity, so it wraps rather than
                      truncating — but it is also a single unbreakable token
                      whenever it is underscored, and a flex item's automatic
                      minimum size is its longest word. Without `min-w-0` the
                      row cannot shrink below that, and a name such as
                      `media_library_transcoder_and_metadata_indexer` pushes
                      the whole page sideways at 390px. */}
                  <span className="min-w-0 break-words font-medium text-text">
                    {service.name}
                  </span>
                  {state ? (
                    <StatusDot
                      state={dockerStateToStatus(state.state)}
                      label={state.state}
                      className="text-muted"
                    />
                  ) : (
                    // Absent from `compose ps` means no container exists — not
                    // the same thing as one that has exited.
                    <StatusDot
                      state="unknown"
                      label="No container"
                      className="text-muted"
                    />
                  )}
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted">
                  {service.image ?? "no image"}
                </p>
                <Ports
                  ports={service.ports}
                  service={service.name}
                  exposures={exposures}
                  onExpose={onExpose}
                  onEditExposure={onEditExposure}
                />
              </li>
            );
          })}
        </ul>
      )}
      {detail.statesError && (
        <p className="mt-3 text-sm text-warning">
          Container status unavailable: {detail.statesError}
        </p>
      )}
    </Section>
  );
}

function Volumes({ detail }: { detail: ProjectDetailData }) {
  return (
    <Section title="Volumes">
      {detail.model === null ? (
        <Note>Unavailable until the compose file parses.</Note>
      ) : detail.model.volumes.length === 0 ? (
        <Note>This project declares no named volumes.</Note>
      ) : (
        <ul className="flex flex-col gap-2">
          {detail.model.volumes.map((volume) => (
            <li
              key={volume.key}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              {/* Same as the service name: the compose key is the thing the
                  reader has to match against their own file, so it wraps
                  instead of being cut, and `min-w-0` is what lets it. */}
              <span className="min-w-0 break-words font-medium text-text">
                {volume.key}
              </span>
              <span className="truncate font-mono text-xs text-muted">
                {volume.name}
              </span>
              {/* An external volume is owned elsewhere; saying so is what stops
                  someone treating it as this project's to delete. */}
              {volume.external && <Badge tone="warning">external</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Snapshots({ detail }: { detail: ProjectDetailData }) {
  return (
    <Section title="Snapshots">
      {detail.snapshots.length === 0 ? (
        <Note>
          No snapshots yet. Homestead writes one before every compose edit.
        </Note>
      ) : (
        <ul className="flex flex-col gap-1">
          {detail.snapshots.map((name) => (
            <li key={name} className="truncate font-mono text-xs text-muted">
              {name}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function duration(op: Operation): string {
  // A running operation has no finish time; measuring it against now is the
  // honest reading, and it is what the user is watching.
  return formatDuration((op.finishedAt ?? Date.now()) - op.startedAt);
}

function RecentOperations({ slug }: { slug: string }) {
  const { data, error, isPending } = useProjectOperations(slug);

  return (
    <Section title="Recent operations">
      {isPending ? (
        <div className="flex justify-center text-muted">
          <Spinner />
        </div>
      ) : // Same rule as the page around it: this list is polled every three
      // seconds while an operation runs, so a failed refetch must not delete
      // the history it already has. The header's notice says it is stale.
      error && !data ? (
        <Note>
          {isRefusal(error)
            ? "Operation history needs an administrator account."
            : `Could not load the operation history. ${error.message}`}
        </Note>
      ) : !data ? null : data.length === 0 ? (
        <Note>Nothing has run for this project yet.</Note>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {data.slice(0, RECENT_LIMIT).map((op) => (
            <li
              key={op.id}
              className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0"
            >
              <span className="font-medium text-text">{op.kind}</span>
              <span className="text-muted">{op.status}</span>
              <span className="text-muted">{duration(op)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * The reference half of the project page: what this stack is made of, and what
 * has happened to it. Never carries a control — those live in the header,
 * because this whole block collapses at `lg` and above.
 */
export function Overview({
  slug,
  detail,
  exposures,
  onExpose,
  onEditExposure,
  onEditIdentity,
}: {
  slug: string;
  detail: ProjectDetailData;
  /** Every exposure; narrowed to this project before use. */
  exposures: ExposureSummary[];
  onExpose: (port: PortOption) => void;
  onEditExposure: (exposure: ExposureSummary) => void;
  onEditIdentity: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* The parse error itself is rendered by ProjectDetail, above the tabs:
          this aside is hidden below `lg` on the Edit tab, which is exactly
          where someone goes to fix the file. */}
      <Section title="Project">
        <div className="flex items-start gap-3">
          {detail.identity?.iconSlug || detail.identity?.iconUrl ? (
            <img
              src={
                detail.identity.iconSlug
                  ? `/api/icons/${detail.identity.iconSlug}`
                  : (detail.identity.iconUrl ?? "")
              }
              alt=""
              className="h-10 w-10 shrink-0 rounded"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="truncate text-text">
              {detail.identity?.displayName || slug}
            </p>
            {detail.identity?.description ? (
              <p className="mt-0.5 text-muted text-sm">
                {detail.identity.description}
              </p>
            ) : (
              <p className="mt-0.5 text-muted text-sm">No description yet.</p>
            )}
          </div>
          <Button variant="ghost" onClick={onEditIdentity}>
            Edit
          </Button>
        </div>
      </Section>
      <Services
        detail={detail}
        // Narrowed here so the port match below needs only the port number.
        exposures={exposures.filter((e) => e.projectSlug === slug)}
        onExpose={onExpose}
        onEditExposure={onEditExposure}
      />
      <Volumes detail={detail} />
      <Snapshots detail={detail} />
      <RecentOperations slug={slug} />
    </div>
  );
}
