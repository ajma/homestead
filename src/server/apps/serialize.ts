import type { AdminApp, ViewerApp } from "@shared/dto";
import type { AppStatus } from "@shared/types";

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
  isSystem: boolean;
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

/**
 * `lastDeployAt` and `runningJobId` are caller-supplied parameters rather than
 * properties read off `row`: both come from a grouped query over `jobs`, not from the
 * `apps` row itself, and every caller has to look them up (or explicitly decide a fresh
 * row has neither) rather than get them silently defaulted to null.
 */
export function toAdminApp(
  row: AppRowLike,
  status: AppStatusSummary,
  lastDeployAt: number | null,
  runningJobId: string | null,
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
    isSystem: row.isSystem,
    showOnLauncher: row.showOnLauncher,
    sortOrder: row.sortOrder,
    graceUntil: row.graceUntil,
    adoptedAt: row.adoptedAt,
    archivedAt: row.archivedAt,
    lastDeployAt,
    runningJobId,
  };
}
