import type { ContainerSummary, Host } from "../host/types.js";

/**
 * Bounds concurrent `inspectContainer` calls, the same shape `GET /api/apps`'s own
 * `docker compose config` fan-out uses (`apps.ts`'s `CONCURRENCY_LIMIT`) and for the
 * same reason: a cold page listing every app would otherwise fire one inspect per
 * running container simultaneously. Measured on a real Docker socket (31 containers,
 * `dockerode`'s `inspect()`): ~0.5ms per container, ~13ms total at this concurrency —
 * negligible next to the 68ms/spawn `docker compose config` cost this mirrors the
 * shape of, but bounded anyway rather than trusting "should be cheap" unmeasured.
 */
const CONCURRENCY_LIMIT = 5;

/**
 * A running container's start time, in epoch seconds — or `null` when it is not
 * running, Docker never recorded a start time for it, or it stopped between
 * `listContainers` and this call (not fatal: a container that just stopped is not one
 * whose uptime this app should be reporting anyway).
 */
async function runningStartedAt(host: Host, container: ContainerSummary): Promise<number | null> {
  if (container.state !== "running") return null;
  try {
    const inspect = await host.inspectContainer(container.id);
    if (inspect.state !== "running" || inspect.startedAt === null) return null;
    const parsedMs = Date.parse(inspect.startedAt);
    return Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : null;
  } catch {
    // The container may have been removed between `listContainers` and this call —
    // ordinary operation, not a page-breaking failure.
    return null;
  }
}

/**
 * The oldest running container's start time for each key in `byKey` (an app's compose
 * project, keyed however the caller likes — `GET /api/apps` keys by project name, a
 * single-app caller can key by anything since there is only one entry).
 *
 * Every container across every key goes into ONE bounded-concurrency batch, not one
 * batch per key: `GET /api/apps` asks about every app on the screen in a single call,
 * so the concurrency cap above is a real bound on simultaneous Docker calls, not one
 * that resets per app and multiplies out to the same unbounded fan-out it exists to
 * prevent. A single-app caller (adopt, create, `PATCH`, `GET /api/apps/:id`) passes one
 * key and gets the same bound for free, over however many containers that one app has.
 *
 * An app with no running container has no entry in the returned map — "not running" is
 * absence, not a `null` a caller could mistake for "checked, found nothing".
 */
export async function oldestStartTimes(
  host: Host,
  byKey: Map<string, ContainerSummary[]>,
): Promise<Map<string, number>> {
  const running = Array.from(byKey.entries()).flatMap(([key, containers]) =>
    containers.filter((c) => c.state === "running").map((container) => ({ key, container })),
  );

  const result = new Map<string, number>();
  for (let i = 0; i < running.length; i += CONCURRENCY_LIMIT) {
    const chunk = running.slice(i, i + CONCURRENCY_LIMIT);
    const started = await Promise.all(
      chunk.map(async ({ key, container }) => ({
        key,
        startedAt: await runningStartedAt(host, container),
      })),
    );
    for (const { key, startedAt } of started) {
      if (startedAt === null) continue;
      const existing = result.get(key);
      if (existing === undefined || startedAt < existing) result.set(key, startedAt);
    }
  }
  return result;
}
