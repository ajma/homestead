import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { operations } from "../db/schema.js";

export type OperationKind = "up" | "down" | "restart" | "pull";
export type OperationStatus = "running" | "succeeded" | "failed";

export type Operation = {
  id: string;
  slug: string;
  kind: OperationKind;
  status: OperationStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
};

type Subscriber = { onChunk: (chunk: string) => void; onEnd: () => void };

type Live = {
  op: Operation;
  buffer: string[];
  subscribers: Set<Subscriber>;
  done: Promise<void>;
  truncated: boolean;
};

/** Caps a runaway `pull` from exhausting memory; the tail is what matters. */
const MAX_BUFFERED_CHUNKS = 5000;
const TRIM_OVERSHOOT = 500;
const MAX_FINISHED_RETENTION = 50;

export function createRegistry(db: Db) {
  const live = new Map<string, Live>();
  const busy = new Set<string>();

  async function start(
    slug: string,
    kind: OperationKind,
    actorUserId: string | null,
    run: (emit: (chunk: string) => void) => Promise<number>,
  ): Promise<Operation> {
    if (busy.has(slug)) {
      throw new Error(`an operation is already running for project "${slug}"`);
    }
    busy.add(slug);

    const op: Operation = {
      id: randomUUID(),
      slug,
      kind,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    const entry: Live = {
      op,
      buffer: [],
      subscribers: new Set(),
      done: Promise.resolve(),
      truncated: false,
    };
    live.set(op.id, entry);

    const emit = (chunk: string) => {
      entry.buffer.push(chunk);
      if (entry.buffer.length > MAX_BUFFERED_CHUNKS + TRIM_OVERSHOOT) {
        const excess = entry.buffer.length - MAX_BUFFERED_CHUNKS;
        entry.buffer.splice(0, excess);
        entry.truncated = true;
      }
      for (const sub of entry.subscribers) sub.onChunk(chunk);
    };

    entry.done = (async () => {
      let code = 1;
      try {
        code = await run(emit);
      } catch (err) {
        emit(`\n${err instanceof Error ? err.message : String(err)}\n`);
        code = 1;
      } finally {
        op.exitCode = code;
        op.status = code === 0 ? "succeeded" : "failed";
        op.finishedAt = Date.now();
        busy.delete(slug);
        for (const sub of entry.subscribers) sub.onEnd();
        entry.subscribers.clear();
        const output = entry.truncated
          ? `[earlier output truncated]\n${entry.buffer.join("")}`
          : entry.buffer.join("");
        await db.insert(operations).values({
          id: op.id,
          projectSlug: slug,
          kind,
          status: op.status,
          exitCode: op.exitCode,
          actorUserId,
          startedAt: op.startedAt,
          finishedAt: op.finishedAt,
          output,
        });
        evictOldFinished();
      }
    })();

    return op;
  }

  function evictOldFinished() {
    const finished = Array.from(live.entries())
      .filter(([, entry]) => entry.op.status !== "running")
      .sort((a, b) => a[1].op.startedAt - b[1].op.startedAt);
    const toEvict = finished.length - MAX_FINISHED_RETENTION;
    for (let i = 0; i < toEvict; i++) {
      const entry = finished[i];
      if (entry) live.delete(entry[0]);
    }
  }

  return {
    start,
    get: (id: string) => live.get(id)?.op,
    wait: (id: string) => live.get(id)?.done ?? Promise.resolve(),
    subscribe(
      id: string,
      onChunk: (chunk: string) => void,
      onEnd: () => void,
    ): () => void {
      const entry = live.get(id);
      if (!entry) {
        onEnd();
        return () => {};
      }
      if (entry.truncated) onChunk("[earlier output truncated]\n");
      for (const chunk of entry.buffer) onChunk(chunk);
      if (entry.op.status !== "running") {
        onEnd();
        return () => {};
      }
      const sub: Subscriber = { onChunk, onEnd };
      entry.subscribers.add(sub);
      return () => entry.subscribers.delete(sub);
    },
    async listForProject(slug: string) {
      return db
        .select()
        .from(operations)
        .where(eq(operations.projectSlug, slug))
        .orderBy(desc(operations.startedAt))
        .limit(50);
    },
  };
}

export type OperationRegistry = ReturnType<typeof createRegistry>;
