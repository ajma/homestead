import { randomUUID } from "node:crypto";
import type {
  Operation,
  OperationKind,
  OperationStatus,
} from "@shared/projects.js";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { operations } from "../db/schema.js";

export type { Operation, OperationKind, OperationStatus };

type Subscriber = { onChunk: (chunk: string) => void; onEnd: () => void };

type Live = {
  op: Operation;
  buffer: string[];
  bufferBytes: number;
  subscribers: Set<Subscriber>;
  done: Promise<void>;
  truncated: boolean;
};

/**
 * Caps a runaway `pull` from exhausting memory; the tail is what matters.
 *
 * Bounded in *bytes*, not chunks: a chunk is whatever the pipe handed us, up to
 * the 64 KB stream high-water mark, so a chunk cap is a memory cap multiplied
 * by an unknown. This process is expected to stay up for months.
 */
const MAX_BUFFER_BYTES = 1024 * 1024;

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
      bufferBytes: 0,
      subscribers: new Set(),
      done: Promise.resolve(),
      truncated: false,
    };
    live.set(op.id, entry);

    const emit = (chunk: string) => {
      entry.buffer.push(chunk);
      entry.bufferBytes += Buffer.byteLength(chunk, "utf8");
      // Drop whole chunks from the head until we are back under the cap, so the
      // tail — the part that says why the operation failed — always survives.
      while (entry.bufferBytes > MAX_BUFFER_BYTES && entry.buffer.length > 1) {
        const dropped = entry.buffer.shift() as string;
        entry.bufferBytes -= Buffer.byteLength(dropped, "utf8");
        entry.truncated = true;
      }
      // A single chunk larger than the whole cap: keep its tail by bytes.
      if (entry.bufferBytes > MAX_BUFFER_BYTES) {
        const only = entry.buffer[0] ?? "";
        const tail = Buffer.from(only, "utf8")
          .subarray(-MAX_BUFFER_BYTES)
          .toString("utf8");
        entry.buffer[0] = tail;
        entry.bufferBytes = Buffer.byteLength(tail, "utf8");
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
        const output = entry.truncated
          ? `[earlier output truncated]\n${entry.buffer.join("")}`
          : entry.buffer.join("");
        // History row first, fan-out second: a client told "done" must never
        // then fail to find the operation it was just told about.
        //
        // But the fan-out is unconditional. SQLITE_FULL on a NAS, SQLITE_BUSY,
        // or a read-only data directory would otherwise leave every open
        // `/api/operations/:id/stream` hanging forever, each retaining its
        // `reply.raw` closure in `subscribers`, with `evictOldFinished`
        // skipped. A missing history row is bad; stranding every subscriber
        // and leaking the buffers is worse.
        try {
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
        } catch (err) {
          console.error(
            `homestacks: failed to record operation ${op.id} (${kind} ${slug}):`,
            err,
          );
        } finally {
          for (const sub of entry.subscribers) sub.onEnd();
          entry.subscribers.clear();
          evictOldFinished();
        }
      }
    })();

    return op;
  }

  const MAX_FINISHED_RETENTION = 50;

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

  /** Row → the shared `Operation` shape. One concept, one shape. */
  function toOperation(row: {
    id: string;
    projectSlug: string;
    kind: string;
    status: string;
    exitCode: number | null;
    startedAt: number;
    finishedAt: number | null;
  }): Operation {
    return {
      id: row.id,
      slug: row.projectSlug,
      kind: row.kind as OperationKind,
      status: row.status as OperationStatus,
      exitCode: row.exitCode,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  const historyColumns = {
    id: operations.id,
    projectSlug: operations.projectSlug,
    kind: operations.kind,
    status: operations.status,
    exitCode: operations.exitCode,
    startedAt: operations.startedAt,
    finishedAt: operations.finishedAt,
  };

  return {
    start,
    get: (id: string) => live.get(id)?.op,
    /**
     * In-memory first, database second. Memory holds only the newest 50 and
     * nothing at all after a restart, but the row outlives both — a client that
     * reloads mid-pull must not be told the operation never existed.
     */
    async find(id: string): Promise<Operation | undefined> {
      const inMemory = live.get(id)?.op;
      if (inMemory) return inMemory;
      const rows = await db
        .select(historyColumns)
        .from(operations)
        .where(eq(operations.id, id))
        .limit(1);
      const row = rows[0];
      return row ? toOperation(row) : undefined;
    },
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
    async listForProject(slug: string): Promise<Operation[]> {
      const rows = await db
        .select(historyColumns)
        .from(operations)
        .where(eq(operations.projectSlug, slug))
        .orderBy(desc(operations.startedAt))
        .limit(50);
      return rows.map(toOperation);
    },
  };
}

export type OperationRegistry = ReturnType<typeof createRegistry>;
