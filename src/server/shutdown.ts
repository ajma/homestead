/**
 * The ordered, idempotent, time-bounded shutdown sequence.
 *
 * The order is not arbitrary and is not a preference — each step exists because of
 * something measured:
 *
 * 1. `scheduler` and `retention` stop first, so no new probe or prune starts against a
 *    database that is about to close.
 * 2. `jobs.shutdown()` cancels in-flight compose children while their output streams are
 *    still attached, so a user watching a deploy sees it end rather than go silent.
 * 3. `stepJobs.shutdown()` waits for any in-flight step sequence (`StepJobRunner`) to
 *    reach its terminal-row write. Unlike `jobs`, this does not cancel anything — see
 *    `StepJobRunner.shutdown`'s own doc for why cancellation is out of scope here and left
 *    for whichever phase first wires a route that can start one. Placed after `jobs`, not
 *    merged into it: the two runners share an `AppLock` but keep independent registries,
 *    and a step sequence's terminal write needs the database exactly as much as a compose
 *    job's does, for the same reason (see point 5).
 * 4. `events.closeAll()` ends every open `/api/events` stream. This must precede
 *    `server.close()`: Fastify's close does not resolve while a stream is open, and
 *    1C's launcher streams stay open for as long as a tab is.
 * 5. `server.close()` drains in-flight requests.
 * 6. `db.close()` last, once the server has drained — or been abandoned. On the
 *    `server.close()` timeout path (see `stageWithTimeout` below) "abandoned" is the
 *    honest word: a timeout means Fastify still has something in flight, and `db.close()`
 *    runs anyway. That in-flight handler sees a closed-client error rather than a clean
 *    response, which is an acceptable loss on a process that is exiting regardless — a
 *    `file:` libSQL client with WAL keeps every already-committed write durable either way.
 *
 * Every stage is individually guarded. A stage that throws must not strand the ones after
 * it — the database handle in particular gets closed even when the server refuses to.
 */
export type Closeable = {
  scheduler: { stop(): void };
  retention: { stop(): void };
  jobs: { shutdown(timeoutMs?: number): Promise<void> };
  stepJobs: { shutdown(timeoutMs?: number): Promise<void> };
  events: { closeAll(): void };
  server: { close(): Promise<void> };
  db: { close(): void };
};

export type ShutdownOptions = {
  /**
   * How long to wait on `server.close()` before giving up on it and moving on.
   *
   * This is the one stage whose promise can legitimately never settle — a client holding
   * a keep-alive connection open is enough — and it is the only stage in the sequence
   * that needs an explicit bound: `scheduler.stop()`/`retention.stop()`/`events.closeAll()`
   * are synchronous, `db.close()` is synchronous, and `jobs.shutdown()`/`stepJobs.shutdown()`
   * already carry their own internal timeouts (`JobRunner` and `StepJobRunner` both default
   * to 10s). Bounding `server.close()` this way means the sequence is *always* guaranteed
   * to reach `db.close()` — never just "probably, if nothing else also happens to hang" —
   * which is the point: an unflushed SQLite handle is worth avoiding, and a `file:` libSQL
   * client with WAL is durable at every committed write regardless, so there is nothing to
   * lose by giving up on the server specifically.
   *
   * Default 20s plus `JobRunner`'s 10s default plus `StepJobRunner`'s 10s default totals a
   * 40s worst case, which is why `compose.example.yaml` sets `stop_grace_period: 55s` —
   * margin above that 40s, not equal to it — after which the orchestrator SIGKILLs
   * regardless of what this function is still doing.
   */
  timeoutMs?: number;
  onError?: (stage: string, error: unknown) => void;
};

const DEFAULT_TIMEOUT_MS = 20_000;

export function createShutdown(parts: Closeable, opts: ShutdownOptions = {}): () => Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onError =
    opts.onError ??
    ((stage: string, error: unknown) => console.error(`[shutdown] ${stage}:`, error));

  // A second SIGTERM — or a SIGINT chasing a SIGTERM — must join the running sequence, not
  // start a parallel one that closes the database out from under it.
  let inProgress: Promise<void> | undefined;

  async function stage(name: string, run: () => void | Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      onError(name, error);
    }
  }

  /**
   * Like `stage`, but abandons `run` after `ms` rather than waiting on it forever. Used
   * only for `server.close()` — see the comment on `ShutdownOptions.timeoutMs`. Abandoning
   * `run` here does not race it against the rest of the sequence: `run` keeps executing in
   * the background (there is nothing to cancel a Fastify `close()` with), this just stops
   * the sequence from waiting on it so `db.close()` is reached unconditionally.
   */
  async function stageWithTimeout(
    name: string,
    run: () => Promise<void>,
    ms: number,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), ms);
    });
    try {
      const outcome = await Promise.race([run().then((): "done" => "done"), timedOut]);
      if (outcome === "timed-out") {
        onError(name, new Error(`${name} did not finish within ${ms}ms`));
      }
    } catch (error) {
      onError(name, error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function sequence(): Promise<void> {
    await stage("scheduler", () => parts.scheduler.stop());
    await stage("retention", () => parts.retention.stop());
    await stage("jobs", () => parts.jobs.shutdown());
    await stage("stepJobs", () => parts.stepJobs.shutdown());
    await stage("events", () => parts.events.closeAll());
    await stageWithTimeout("server", () => parts.server.close(), timeoutMs);
    await stage("db", () => parts.db.close());
  }

  return function shutdown(): Promise<void> {
    if (!inProgress) inProgress = sequence();
    return inProgress;
  };
}
