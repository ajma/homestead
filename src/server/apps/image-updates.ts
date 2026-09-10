import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type apps, imageStatus } from "../db/schema.js";
import type { Host } from "../host/types.js";
import type { ComposeConfigCache } from "./compose-config.js";
import { parseImageRef } from "./registry.js";

/**
 * The digest for the repository we are actually checking.
 *
 * An image tagged into more than one repository carries one `RepoDigests` entry per
 * repository — `["nginx@sha256:A", "myregistry.com/nginx@sha256:B"]`. Taking index 0
 * compares a digest from Docker Hub against one fetched from a private registry, which
 * never matches, so the app shows an update that pulling can never clear. A badge that
 * never goes away is worse than no badge: it teaches the user to ignore all of them.
 */
function digestForRepository(repoDigests: string[], image: string): string | null {
  const wanted = parseImageRef(image).repository;
  for (const entry of repoDigests) {
    const [repo, digest] = entry.split("@");
    if (repo === undefined || digest === undefined) continue;
    if (parseImageRef(repo).repository === wanted) return digest;
  }
  // No entry names this repository — comparing an unrelated one would invent an update.
  return null;
}

export type AppRow = typeof apps.$inferSelect;

export class ImageUpdateChecker {
  constructor(
    private readonly deps: {
      db: Db;
      host: Host;
      composeConfig: ComposeConfigCache;
      registry: { latestDigest(image: string): Promise<string | null> };
    },
  ) {}

  /**
   * Compares each service's local image digest against the registry's.
   *
   * Never throws. This runs across every app on a schedule, and one unresolvable compose
   * file or one unreachable registry must not stop the rest.
   */
  async check(app: AppRow): Promise<void> {
    const resolved = await this.deps.composeConfig.resolve({
      directory: app.directory,
      composeFile: app.composeFile,
    });
    if (!resolved.valid) return;

    const checkedAt = Math.floor(Date.now() / 1000);

    for (const service of resolved.resolved.services) {
      if (!service.image) continue;

      let currentDigest: string | null = null;
      let latestDigest: string | null = null;

      // Try to inspect the local image. A wedged Docker socket throws; in that case
      // currentDigest stays null and we still write a row so the service appears as
      // "checked, could not tell" rather than being silently absent.
      try {
        const local = await this.deps.host.inspectImage(service.image);
        currentDigest = local ? digestForRepository(local.repoDigests, service.image) : null;
      } catch {
        // Leave currentDigest as null
      }

      // latestDigest never throws by contract, but returns null when unreachable
      latestDigest = await this.deps.registry.latestDigest(service.image);

      // Both must be known. A null latest means the registry could not be reached, and
      // reporting unknown as "update available" trains the user to ignore the badge.
      const updateAvailable =
        currentDigest !== null && latestDigest !== null && currentDigest !== latestDigest;

      const row = {
        appId: app.id,
        serviceName: service.name,
        currentDigest,
        latestDigest,
        updateAvailable,
        checkedAt,
      };

      // The write is inside its own guard. A locked database, a full disk, or the app
      // being deleted mid-sweep would otherwise throw straight out of `check()` — which is
      // documented as never throwing, and which 1C calls in a loop over every app, so
      // one bad write would end the sweep for everything after it.
      try {
        await this.deps.db
          .insert(imageStatus)
          .values(row)
          .onConflictDoUpdate({
            target: [imageStatus.appId, imageStatus.serviceName],
            set: row,
          });
      } catch {
        // Database write failed, skip this service
      }
    }

    // Forget services the compose file no longer declares. Without this a service that
    // was removed keeps its row forever, and its stale badge advertises an update for
    // something that no longer exists.
    try {
      const live = resolved.resolved.services.map((service) => service.name);
      await this.deps.db
        .delete(imageStatus)
        .where(
          live.length === 0
            ? eq(imageStatus.appId, app.id)
            : and(eq(imageStatus.appId, app.id), notInArray(imageStatus.serviceName, live)),
        );
    } catch {
      // Same contract. A stale row is a cosmetic problem; ending the sweep is not.
    }
  }
}
