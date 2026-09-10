import type { AdminApp, ViewerApp } from "@shared/dto.js";
import type { AppStatus } from "@shared/types.js";

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

export type AppStatusSummary = { status: AppStatus; detail: string | null };

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

export function toAdminApp(row: AppRowLike, status: AppStatusSummary): AdminApp {
  return {
    ...toViewerApp(row, status),
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
  };
}
