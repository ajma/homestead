import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Db } from "../db/client.js";
import { apps, jobs } from "../db/schema.js";
import type { Host, JobChunk, JobHandle } from "../host/types.js";
import type { ComposeConfigCache } from "./compose-config.js";

export const JOB_KINDS = ["up", "down", "restart", "pull"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** The compose arguments each action maps to. Fixed here so no caller can pass its own. */
const ARGS: Record<JobKind, string[]> = {
  up: ["up", "-d"],
  down: ["down"],
  restart: ["restart"],
  pull: ["pull"],
};

/** A `pull` on a large stack runs for minutes; 30 is generous without being unbounded. */
const JOB_TIMEOUT_MS = 30 * 60_000;
/** Persisted output cap. The tail is kept — the end is where the error is. */
const OUTPUT_CAP = 256 * 1024;
/** Seconds after a job during which probe failures render as `starting` (spec §4). */
const GRACE_SECONDS = 120;

export class JobBusyError extends Error {
  constructor(readonly runningJobId: string) {
    super("Another job is already running for this app");
    this.name = "JobBusyError";
  }
}

export type AppRow = typeof apps.$inferSelect;

export type RunningJob = {
  id: string;
  appId: string;
  kind: JobKind;
  output: AsyncIterable<JobChunk>;
  done: Promise<void>;
};

export class JobRunner {
  /**
   * The per-app mutex, and the registry the SSE route reads to attach to a job already in
   * flight. In-process because Homestead is one Node process by design (spec §2) — a
   * second process would need a row lock instead.
   */
  private readonly running = new Map<string, RunningJob & { handle: JobHandle }>();

  constructor(private readonly deps: { db: Db; host: Host; composeConfig: ComposeConfigCache }) {}

  live(jobId: string): RunningJob | undefined {
    for (const job of this.running.values()) if (job.id === jobId) return job;
    return undefined;
  }

  cancel(jobId: string): boolean {
    for (const job of this.running.values()) {
      if (job.id === jobId) {
        job.handle.cancel();
        return true;
      }
    }
    return false;
  }

  async start(app: AppRow, kind: JobKind, userId: string): Promise<RunningJob> {
    const inFlight = this.running.get(app.id);
    if (inFlight) throw new JobBusyError(inFlight.id);

    const id = ulid();
    const startedAt = Math.floor(Date.now() / 1000);
    await this.deps.db.insert(jobs).values({
      id,
      appId: app.id,
      kind,
      status: "running",
      startedAt,
      userId,
    });

    const handle = this.deps.host.runCompose(
      { directory: app.directory, composeFile: app.composeFile },
      ARGS[kind],
      { timeoutMs: JOB_TIMEOUT_MS },
    );

    // Reserve the slot before any await, so two starts in the same tick cannot both pass
    // the check above.
    const job: RunningJob & { handle: JobHandle } = {
      id,
      appId: app.id,
      kind,
      handle,
      output: handle.output,
      done: Promise.resolve(),
    };
    this.running.set(app.id, job);

    job.done = this.finish(app, job, handle);
    return job;
  }

  private async finish(app: AppRow, job: RunningJob, handle: JobHandle): Promise<void> {
    try {
      const result = await handle.result;
      const combined = [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
      const output =
        combined.length > OUTPUT_CAP
          ? `… output truncated, showing the last ${OUTPUT_CAP} characters …\n${combined.slice(combined.length - OUTPUT_CAP)}`
          : combined;

      await this.deps.db
        .update(jobs)
        .set({
          status: result.exitCode === 0 ? "succeeded" : "failed",
          exitCode: result.exitCode,
          finishedAt: Math.floor(Date.now() / 1000),
          output,
        })
        .where(eq(jobs.id, job.id));

      // The config and the container set are both stale now: `up` can pull a new image and
      // `pull` certainly does.
      this.deps.composeConfig.invalidate({
        directory: app.directory,
        composeFile: app.composeFile,
      });

      // Set on completion, not on start. During a multi-minute `pull` the old containers
      // are still up and their status is real; suppressing it would hide a live failure.
      await this.deps.db
        .update(apps)
        .set({ graceUntil: Math.floor(Date.now() / 1000) + GRACE_SECONDS })
        .where(eq(apps.id, app.id));
    } finally {
      // Always, or a failed job wedges the app until restart.
      this.running.delete(app.id);
    }
  }
}
