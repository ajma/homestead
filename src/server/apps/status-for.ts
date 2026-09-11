import type { apps } from "../db/schema.js";
import type { ContainerSummary, Host } from "../host/types.js";
import type { ComposeConfigCache } from "./compose-config.js";
import { inGraceWindow } from "./grace.js";
import type { AppStatusSummary } from "./serialize.js";
import { rollUpStatus } from "./status.js";

export type StatusDeps = { host: Host; composeConfig: ComposeConfigCache };
export type AppRow = typeof apps.$inferSelect;

/**
 * The project name compose would use for this app right now.
 *
 * `apps.projectName` is written at adoption and reconciled after writes made through
 * Homestead, but an SSH edit to `.env` setting `COMPOSE_PROJECT_NAME` changes it
 * underneath us. Measured: the stored name then matches no container, so a running stack
 * reports `down` with every service missing, the containers list is empty, and the logs
 * route 404s. Resolving is already happening for the status rollup; using its answer
 * costs nothing.
 *
 * The stored copy remains the fallback: when compose cannot be resolved at all we have
 * nothing better, and a stale name beats no name.
 */
export async function currentProjectName(deps: StatusDeps, row: AppRow): Promise<string> {
  try {
    const resolved = await deps.composeConfig.resolve({
      directory: row.directory,
      composeFile: row.composeFile,
    });
    if (resolved.valid && resolved.resolved.projectName !== "") {
      return resolved.resolved.projectName;
    }
  } catch {
    // Unreadable compose file. Fall through.
  }
  return row.projectName ?? "";
}

export async function statusFor(
  deps: StatusDeps,
  row: AppRow,
  containers?: ContainerSummary[],
): Promise<AppStatusSummary> {
  const target = { directory: row.directory, composeFile: row.composeFile };
  try {
    const resolved = await deps.composeConfig.resolve(target);
    if (!resolved.valid) {
      // Raw `docker compose config` stderr routinely carries absolute paths and
      // interpolated `.env` values, so it goes in `adminDetail` and the viewer gets a
      // description instead.
      return {
        status: "unknown",
        detail: "compose configuration is invalid",
        adminDetail: resolved.message,
      };
    }
    const found =
      containers ?? (await deps.host.listContainers({ project: resolved.resolved.projectName }));
    const rolled = rollUpStatus(resolved.resolved.services, found);

    // A deploy just wrote `graceUntil` (`job-runner.ts`) precisely so a stack mid-`docker
    // compose up` does not read as failed while its containers are still coming up.
    // `applyTransition` already honours this for the probe pipeline the launcher shows;
    // without the same check here, this function's own callers — `/api/apps` and the
    // edit header among them — disagreed with it for the whole ~2 minute window. `unknown`
    // is excluded: that status means the compose file itself could not be resolved, a
    // configuration problem grace has nothing to do with.
    const stillFailing = rolled.status !== "up" && rolled.status !== "unknown";
    if (stillFailing && inGraceWindow(row.graceUntil, Math.floor(Date.now() / 1000))) {
      return { status: "starting", detail: rolled.detail };
    }
    return rolled;
  } catch (error) {
    // The compose root is an SMB share the user edits over SSH, so a renamed or moved
    // file is ordinary operation, not an exception worth a 500.
    return {
      status: "unknown",
      detail: "compose file could not be read",
      adminDetail: error instanceof Error ? error.message : String(error),
    };
  }
}
