import { PreflightError, type PreflightResult } from "./host/preflight.js";
import { type Closeable, createShutdown, type ShutdownOptions } from "./shutdown.js";

/**
 * The boot sequence, extracted from `index.ts` so it has somewhere to be tested.
 *
 * `index.ts` is a top-level-await ESM entry point with real side effects (it opens a
 * database, binds a port, talks to the Docker socket) — which is exactly why it had zero
 * test coverage before this module existed. The 1H whole-branch review measured that a
 * refactor could delete the preflight gate, reorder the startup sweep to run after
 * `listen`, and remove both signal handlers, all at once, and the suite stayed green: the
 * three properties that matter were enforced by nothing but the physical layout of one
 * file. This module exists so they are enforced by an assertion instead.
 *
 * Every side-effecting step is a parameter so the ordering itself — not the business logic
 * inside each step, which is already covered where it lives — is what `startup.test.ts`
 * exercises.
 */
export type RuntimeParts = {
  /** Everything `createShutdown` needs to stop, except `db` — added once it is known. */
  closeable: Omit<Closeable, "db">;
  /** Starts the scheduler's and retention timer's intervals. Not started any earlier: a
   * probe or a prune firing before `listen` has nothing to serve results to yet, and
   * firing before the sweep has run could race a `running` row the sweep is about to
   * repair. */
  startTimers: () => void;
  listen: (opts: { port: number; host: string }) => Promise<void>;
};

export type StartupDeps<TDb> = {
  skipPreflight: boolean;
  runPreflight: () => Promise<PreflightResult>;
  createDb: () => Promise<{ db: TDb; closeDb: () => void }>;
  runMigrations: (db: TDb) => Promise<void>;
  sweepStrandedJobs: (db: TDb, nowSeconds: number) => Promise<number>;
  now: () => number;
  /** Assembles everything else — host, jobs, scheduler, the Fastify app itself — and
   * returns just enough to start timers, shut down, and listen. Its own internal
   * ordering is not this module's concern; only where it falls relative to the
   * preflight, the sweep, and `listen` is. */
  buildRuntime: (db: TDb) => Promise<RuntimeParts>;
  listenOptions: { port: number; host: string };
  signals: readonly NodeJS.Signals[];
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void;
  onUncaughtException: (handler: (error: unknown) => void) => void;
  onUnhandledRejection: (handler: (reason: unknown, promise: unknown) => void) => void;
  exit: (code: number) => void;
  log: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (...args: unknown[]) => void;
  };
  shutdownOptions?: ShutdownOptions;
};

/**
 * Runs the boot sequence described by `deps` and does not return until the server is
 * listening (or boot has failed, in which case it rejects and the caller is expected to
 * exit non-zero — see `index.ts`).
 *
 * Two things are deliberately NOT symmetric with the old inline version, both traced to
 * 1H review findings:
 *
 * - The `SIGTERM`/`SIGINT` handlers are installed FIRST, before the preflight even runs,
 *   not after the runtime is built. Until a real shutdown sequence exists there is nothing
 *   graceful to do — no port bound, no timers started — so a signal received during boot
 *   exits immediately (143) rather than either killing the process with no log line (the
 *   pre-1H default) or silently doing nothing (Minor: index.ts:124 in the review). Once
 *   `createShutdown` has run, the same handler switches to the real sequence. This was the
 *   chosen resolution to that review's judgment call: installing earlier here is cheap
 *   because the handler only needs a mutable reference, not the runtime itself. This
 *   closes the gap for the whole preflight/migrations/host-init window the review's Minor
 *   finding named, but not the very first stretch of a container's life: measured
 *   in-container, ~1-1.5s elapses between the container's start time and this line
 *   actually running, all of it Node/module-loading overhead before any of Homestead's
 *   own code executes. A signal landing in that narrower window is still lost — this is a
 *   property of running plain `node` as PID 1 with no init process, not of this file, and
 *   is not something reordering code inside it can close further.
 * - `uncaughtException`/`unhandledRejection` are installed LAST, only once `listen` has
 *   actually resolved (Important 3 in the review). Their whole rationale — a single-process
 *   appliance should log and keep serving rather than vanish — presupposes there is
 *   something to keep serving. Registering them before `listen` let a listen failure
 *   (observed in-container as `EADDRINUSE`) be logged and swallowed, leaving a container
 *   that `docker inspect` reports as `running` forever with nothing bound to the port, and
 *   that `restart: unless-stopped` therefore never restarts. With no handler installed
 *   yet, a rejected `listen` propagates out of this function; `index.ts` turns that into a
 *   non-zero exit.
 */
export async function startServer<TDb>(deps: StartupDeps<TDb>): Promise<void> {
  let shutdown: (() => Promise<void>) | undefined;

  for (const signal of deps.signals) {
    deps.onSignal(signal, () => {
      if (shutdown) {
        deps.log.info(`[shutdown] ${signal} received.`);
        void shutdown().then(
          () => deps.exit(0),
          () => deps.exit(1),
        );
      } else {
        deps.log.info(`[shutdown] ${signal} received during startup; exiting immediately.`);
        deps.exit(143);
      }
    });
  }

  if (!deps.skipPreflight) {
    const result = await deps.runPreflight();
    if (!result.ok) throw new PreflightError(result.reason);
  }

  const { db, closeDb } = await deps.createDb();
  await deps.runMigrations(db);

  // Before anything can start a new job. A `running` row at this point is from a previous
  // life of this process — see `sweepStrandedJobs`.
  const swept = await deps.sweepStrandedJobs(db, deps.now());
  if (swept > 0) deps.log.warn(`[startup] Marked ${swept} interrupted job(s) as failed.`);

  const runtime = await deps.buildRuntime(db);
  runtime.startTimers();

  shutdown = createShutdown({ ...runtime.closeable, db: { close: closeDb } }, deps.shutdownOptions);

  await runtime.listen(deps.listenOptions);

  // See the note above: only reachable once `listen` has actually succeeded.
  deps.onUnhandledRejection((reason, promise) => {
    deps.log.error("[process] Unhandled rejection at:", promise, "reason:", reason);
  });
  deps.onUncaughtException((error) => {
    deps.log.error("[process] Uncaught exception:", error);
  });
}
