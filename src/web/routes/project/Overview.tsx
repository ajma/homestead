import type { Operation, PublishedPort } from "@shared/projects.js";
import type { ReactNode } from "react";
import { Badge, Panel, Spinner, StatusDot } from "../../components/ui/index.js";
import { ApiError } from "../../lib/api.js";
import {
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

function Ports({ ports }: { ports: PublishedPort[] }) {
  if (ports.length === 0)
    return <p className="mt-1 text-sm text-muted">No published ports</p>;
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {ports.map((port) => (
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
        </li>
      ))}
    </ul>
  );
}

function Services({ detail }: { detail: ProjectDetailData }) {
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
                  <span className="font-medium text-text">{service.name}</span>
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
                <Ports ports={service.ports} />
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
              <span className="font-medium text-text">{volume.key}</span>
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
      ) : error ? (
        <Note>
          {error instanceof ApiError && error.status === 403
            ? "Operation history needs an administrator account."
            : `Could not load the operation history. ${error.message}`}
        </Note>
      ) : data.length === 0 ? (
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
}: {
  slug: string;
  detail: ProjectDetailData;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* The parse error itself is rendered by ProjectDetail, above the tabs:
          this aside is hidden below `lg` on the Edit tab, which is exactly
          where someone goes to fix the file. */}
      <Services detail={detail} />
      <Volumes detail={detail} />
      <Snapshots detail={detail} />
      <RecentOperations slug={slug} />
    </div>
  );
}
