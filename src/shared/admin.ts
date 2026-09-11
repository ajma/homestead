import type { AppStatus, FaultClass, ProbeKind } from "./types.js";

/**
 * Plain structural types, not derived from Drizzle's `$inferSelect`. This file ships to
 * the browser: inferring from the schema would drag `drizzle-orm` and the schema itself
 * into the web bundle. The server imports these same types rather than redeclaring them,
 * so a column added or renamed underneath one of these shapes is a `tsc` failure at the
 * server call site, not a field that silently goes missing on an admin screen.
 */

/** Docker's live view of one container, as `Host#listContainers` reports it. */
export type ContainerSummary = {
  id: string;
  names: string[];
  image: string;
  state: string;
  status: string;
  project: string | null;
  service: string | null;
  labels: Record<string, string>;
};

/**
 * `GET /api/apps/:id/containers`'s payload. `dockerReachable: false` and an empty
 * `containers` list both render "nothing to show", but they are not the same fact:
 * one means the stack has no containers, the other means Homestead cannot see Docker
 * at all. Collapsing them into a bare array — as this endpoint used to — tells an
 * admin their stack is stopped when it may well be running fine; this is the same
 * `null`-versus-`[]` distinction `docker-runner.ts` makes for the probe engine.
 */
export type ContainersResponse = { containers: ContainerSummary[]; dockerReachable: boolean };

/** One row of the `jobs` table: a single compose invocation's lifecycle. */
export type JobRow = {
  id: string;
  appId: string | null;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  output: string | null;
  userId: string | null;
  createdAt: number;
};

/** One row of the `image_status` table: one compose service's image freshness. */
export type ImageStatusRow = {
  appId: string;
  serviceName: string;
  currentDigest: string | null;
  latestDigest: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
};

/** One row of the `probes` table: its configuration plus its denormalised current state. */
export type ProbeRow = {
  id: string;
  appId: string;
  kind: ProbeKind;
  label: string | null;
  target: string | null;
  expectedStatusPattern: string;
  timeoutMs: number;
  intervalSeconds: number;
  insecureTls: boolean;
  followRedirects: boolean;
  enabled: boolean;
  nextRunAt: number;
  consecutiveFailures: number;
  lastStatus: AppStatus;
  lastLatencyMs: number | null;
  lastDetail: Record<string, unknown> | null;
  lastFaultClass: FaultClass | null;
  lastCheckedAt: number | null;
  statusSince: number | null;
};

/** One compose directory the scan found on disk, joined to any containers it labels. */
export type DiscoveredApp = {
  directory: string;
  composeFile: string;
  projectName: string | null;
  containerCount: number;
  running: boolean;
  adopted: boolean;
};

/** A compose project with running containers but no directory the scan could trace it to. */
export type OrphanStack = { projectName: string; containerCount: number };

/** `GET /api/apps/scan`'s payload: every directory found, plus every unclaimed project. */
export type ScanResult = { discovered: DiscoveredApp[]; orphans: OrphanStack[] };
