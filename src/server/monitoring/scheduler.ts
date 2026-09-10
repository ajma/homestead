import { and, eq, lte } from "drizzle-orm";
import type { ComposeConfigCache } from "../apps/compose-config.js";
import type { Db } from "../db/client.js";
import { apps, probes } from "../db/schema.js";
import type { ContainerSummary, Host } from "../host/types.js";
import { type PersistedTransition, persistResult } from "./persist.js";
import type { ProbeRow, ProbeRunner } from "./types.js";

const TICK_MS = 5_000;
const CONCURRENCY = 8;
const JITTER_FRACTION = 0.1;
const FAILURE_THRESHOLD = 2;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly listeners = new Set<(t: PersistedTransition) => void>();
  /** Tail of the persistence chain. See `serialise`. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      db: Db;
      host: Host;
      composeConfig: ComposeConfigCache;
      runners: Record<ProbeRow["kind"], ProbeRunner>;
      /**
       * Called when one probe's turn fails. The scheduler deliberately continues, so
       * without this a systemic fault — a wedged database, a bad migration — looks
       * exactly like everything working.
       */
      onProbeError?: (probeId: string, error: unknown) => void;
      now?: () => number;
      random?: () => number;
    },
  ) {}

  /** Transitions only. The SSE route subscribes; nothing else should need this. */
  onTransition(listener: (t: PersistedTransition) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    // Deliberately left ref'd: `app.listen()` already keeps the process open, so there is
    // nothing to save by unref-ing this timer, and on this Node version an unref'd
    // `Timeout` is invisible to `process.getActiveResourcesInfo()` — the one public API
    // that can observe it without the flaky `_getActiveHandles()` this project has
    // already been burned by. Unref-ing here would make `stop()` untestable, not lighter.
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Runs every due probe. Never throws.
   *
   * A tick that throws would be swallowed by `setInterval`'s void call and vanish, so the
   * guarantee is not decoration: it is what keeps a single malformed probe row from
   * silently stopping all monitoring.
   */
  async tick(): Promise<number> {
    // A slow tick must not overlap itself. This is also what makes `persistResult` safe:
    // it computes the transition from a `ProbeRow` read earlier in the tick, so two
    // concurrent runs of one probe would both start from the same
    // `consecutiveFailures` and each write 1 where the second should write 2. One tick
    // at a time, and each probe appearing once per tick, is what prevents that.
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const now = this.now();
      const due = await this.deps.db
        .select()
        .from(probes)
        .where(and(eq(probes.enabled, true), lte(probes.nextRunAt, now)));

      if (due.length === 0) return 0;

      // One snapshot for every docker probe in this tick. Sixty apps must not mean sixty
      // Engine API calls a minute. `null` means the call failed, which the runner reports
      // as a network fault rather than blaming every app at once.
      let containers: ContainerSummary[] | null = null;
      if (due.some((probe) => probe.kind === "docker")) {
        try {
          // No filter: the whole host in one call. `LocalHost` already asks Docker for
          // stopped containers too, which the rollup needs to report a service as down.
          containers = await this.deps.host.listContainers();
        } catch {
          containers = null;
        }
      }

      await this.runAll(due, containers, now);
      return due.length;
    } catch {
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  private async runAll(
    due: ProbeRow[],
    containers: ContainerSummary[] | null,
    now: number,
  ): Promise<void> {
    const queue = [...due];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const probe = queue.shift();
        if (!probe) return;
        await this.runOne(probe, containers, now);
      }
    });
    await Promise.all(workers);
  }

  /**
   * Runs database work one at a time, however many probes are in flight.
   *
   * A second `db.transaction()` opened while the first is active fails in BOTH
   * environments, with different errors — measured:
   *
   *   | during an open transaction | `:memory:` (tests) | file-backed (production) |
   *   |---|---|---|
   *   | another transaction        | TRANSACTION_ACTIVE | SQLITE_BUSY              |
   *   | a plain read               | rejected           | fine                     |
   *
   * So serialising is required in production too, not merely to satisfy the tests. The
   * difference is scope: in memory the whole client is one connection, so every
   * statement must queue, while a file-backed database serves concurrent reads happily
   * and only rejects an overlapping transaction. That is why the reschedule UPDATE and
   * the app SELECT are queued as well — they have to be for `:memory:`, and the cost on
   * a file is negligible.
   *
   * Do not "optimise" the reads back out on the grounds that production allows them:
   * the test suite runs entirely in memory and would start failing intermittently.
   *
   * Measured before this existed: with the concurrency limit at 8, twelve probes ran,
   * the runner was called twelve times, and ZERO samples survived — every result was
   * swallowed by the per-probe catch while the tick reported success.
   *
   * The concurrency limit exists for the slow part — Docker and HTTP — and that stays
   * parallel. Only the database work is serialised, and it is milliseconds.
   */
  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    // Keep the chain alive after a rejection, without swallowing it for the caller.
    this.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async runOne(
    probe: ProbeRow,
    containers: ContainerSummary[] | null,
    now: number,
  ): Promise<void> {
    // Reschedule FIRST, in its own statement, so a probe whose runner throws does not
    // stay due and get retried every 5 seconds forever.
    await this.reschedule(probe, now);

    try {
      // Through the queue too. See `serialise` for why: required for `:memory:`, free on
      // a file.
      const [app] = await this.serialise(() =>
        this.deps.db.select().from(apps).where(eq(apps.id, probe.appId)),
      );
      if (!app) return;

      const runner = this.deps.runners[probe.kind];
      const result = await runner.run(probe, {
        app,
        containers,
        deps: { host: this.deps.host, composeConfig: this.deps.composeConfig },
      });

      const transition = await this.serialise(() =>
        persistResult(this.deps.db, probe, result, {
          now,
          graceUntil: app.graceUntil,
          failureThreshold: FAILURE_THRESHOLD,
        }),
      );

      if (transition.changed) {
        for (const listener of this.listeners) {
          try {
            listener(transition);
          } catch {
            // A subscriber's failure is not the scheduler's problem, and must not stop
            // the remaining subscribers or the tick.
          }
        }
      }
    } catch (error) {
      // One probe's failure ends that probe's turn, not the tick — but it must not be
      // invisible. A silent catch here hid every probe result being dropped: the tick
      // reported success while zero samples survived. See `serialise`.
      this.deps.onProbeError?.(probe.id, error);
    }
  }

  private async reschedule(probe: ProbeRow, now: number): Promise<void> {
    // ±10%. Sixty probes created in one adoption pass would otherwise fire in the same
    // second, forever.
    const spread = probe.intervalSeconds * JITTER_FRACTION;
    const offset = (this.random() * 2 - 1) * spread;
    const nextRunAt = Math.round(now + probe.intervalSeconds + offset);
    // Through the same queue as `persistResult`. See `serialise` for why: required for
    // `:memory:`, free on a file.
    await this.serialise(() =>
      this.deps.db.update(probes).set({ nextRunAt }).where(eq(probes.id, probe.id)),
    );
  }

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private random(): number {
    return this.deps.random?.() ?? Math.random();
  }
}
