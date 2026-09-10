import type { Db } from "../db/client.js";
import { type apps, imageStatus } from "../db/schema.js";
import type { Host } from "../host/types.js";
import type { ComposeConfigCache } from "./compose-config.js";

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

      try {
        const local = await this.deps.host.inspectImage(service.image);
        // `RepoDigests` entries look like `nginx@sha256:…`; the digest is what compares.
        const currentDigest = local?.repoDigests[0]?.split("@")[1] ?? null;
        const latestDigest = await this.deps.registry.latestDigest(service.image);

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

        await this.deps.db
          .insert(imageStatus)
          .values(row)
          .onConflictDoUpdate({
            target: [imageStatus.appId, imageStatus.serviceName],
            set: row,
          });
      } catch {
        // A wedged Docker socket or other error on one service must not prevent the
        // rest from being checked. Silently skip this service and continue.
      }
    }
  }
}
