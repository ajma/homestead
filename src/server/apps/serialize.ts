import type { AdminApp, ViewerApp } from "@shared/dto";
import type { AppStatus } from "@shared/types";
import { collectPorts, type ResolvedService } from "./compose-config.js";

/** Just enough of an `apps` row to serialise. Structural, so tests need no database. */
export type AppRowLike = {
  id: string;
  hostId: string;
  slug: string;
  displayName: string;
  description: string | null;
  iconRef: string | null;
  category: string | null;
  sortOrder: number;
  showOnLauncher: boolean;
  directory: string;
  composeFile: string;
  projectName: string;
  launchInternalUrl: string | null;
  lastComposeHash: string | null;
  systemKind: "self" | "cloudflared" | null;
  graceUntil: number | null;
  adoptedAt: number;
  archivedAt: number | null;
};

/**
 * `detail` is safe for any role. `adminDetail` carries raw tool output and reaches only
 * `toAdminApp`.
 *
 * Measured before this split existed: a viewer's `statusDetail` read
 * `validating /volume2/docker/jellyfin/compose.yaml: services.web.environment.API_KEY:
 * invalid value "sk-live-9f3c8" from /volume2/docker/jellyfin/.env` — a filesystem path
 * and an interpolated secret, shown to the housemate the viewer role exists to be safe
 * for. Two fields make the leak structurally impossible instead of something a future
 * caller has to remember; a single field that callers must sanitise fails open.
 */
export type AppStatusSummary = {
  status: AppStatus;
  detail: string | null;
  adminDetail?: string | null;
  /**
   * The compose file's own resolved services, present exactly when `statusFor` got far
   * enough to resolve one (absent for `unknown` from an unreadable/invalid compose
   * file, since there is nothing to report ports for). Carried here rather than
   * re-resolved by `toAdminApp`'s caller: `statusFor` already ran `composeConfig.resolve`
   * to compute status, and `ComposeConfigCache.resolve` re-hashes every input file on
   * every call — cheap once cached (no subprocess), but not free — so a second resolve
   * purely to read `publishedPorts` would double that file I/O for every row on the one
   * screen that lists every app. `toViewerApp` never reads this field, so a viewer's
   * shape is unaffected by its presence here.
   */
  services?: ResolvedService[];
};

/**
 * Every property is listed explicitly. Do not rewrite this as a spread-and-delete —
 * that inverts the failure mode, so a new column leaks until someone remembers to
 * exclude it.
 */
export function toViewerApp(row: AppRowLike, status: AppStatusSummary): ViewerApp {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    iconRef: row.iconRef,
    category: row.category,
    launchUrl: row.launchInternalUrl,
    status: status.status,
    statusDetail: status.detail,
  };
}

/** Every field `toAdminApp` cannot read off `row` or `status` alone — see its own doc
 *  comment for why each one is a caller-supplied parameter rather than silently
 *  defaulted. */
export type AdminAppExtras = {
  lastDeployAt: number | null;
  runningJobId: string | null;
  /** The hostname this app is exposed at, or `null` when it has none — from the
   *  `exposures` table, one grouped query per caller (`exposureHostnames.ts`), never a
   *  per-row lookup. */
  exposureHostname: string | null;
  /** The oldest of this app's currently-running containers' start times, epoch seconds,
   *  or `null` when the app is not running (or Docker is unreachable). See `uptime.ts`. */
  uptimeSince: number | null;
};

/**
 * `lastDeployAt`, `runningJobId`, `exposureHostname` and `uptimeSince` are
 * caller-supplied rather than properties read off `row`: none of them come from the
 * `apps` row itself (a grouped query over `jobs`, over `exposures`, and a Docker
 * inspect respectively), and every caller has to look them up — or explicitly decide a
 * fresh row has none of them — rather than get them silently defaulted.
 *
 * `ports` is different: it comes from `status.services`, already resolved by
 * `statusFor` to compute `status` itself (see `AppStatusSummary.services`'s own doc
 * comment on why this reuses that resolve rather than running a second one), so it is
 * derived here rather than threaded through as a fifth extra a caller would otherwise
 * have to remember to compute.
 */
export function toAdminApp(
  row: AppRowLike,
  status: AppStatusSummary,
  extras: AdminAppExtras,
): AdminApp {
  return {
    ...toViewerApp(row, status),
    // Raw tool output, which `toViewerApp` deliberately never sees.
    statusDetail: status.adminDetail ?? status.detail,
    hostId: row.hostId,
    directory: row.directory,
    composeFile: row.composeFile,
    projectName: row.projectName,
    lastComposeHash: row.lastComposeHash,
    systemKind: row.systemKind,
    showOnLauncher: row.showOnLauncher,
    sortOrder: row.sortOrder,
    graceUntil: row.graceUntil,
    adoptedAt: row.adoptedAt,
    archivedAt: row.archivedAt,
    lastDeployAt: extras.lastDeployAt,
    runningJobId: extras.runningJobId,
    exposureHostname: extras.exposureHostname,
    uptimeSince: extras.uptimeSince,
    ports: collectPorts(status.services ?? []),
  };
}
