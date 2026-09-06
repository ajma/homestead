import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { operations } from "../db/schema.js";
import { createRegistry } from "./registry.js";

let db: Db;
let registry: ReturnType<typeof createRegistry>;

/**
 * `listForProject` deliberately excludes `output`, so buffer assertions read
 * the stored blob straight from the table rather than through the interface.
 */
async function storedOutput(id: string): Promise<string> {
  const rows = await db
    .select({ output: operations.output })
    .from(operations)
    .where(eq(operations.id, id));
  return rows[0]?.output ?? "";
}

const MAX_BUFFER_BYTES = 1024 * 1024;

const deferred = () => {
  let resolve!: (code: number) => void;
  const promise = new Promise<number>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

beforeEach(async () => {
  db = createDb(":memory:");
  await runMigrations(db);
  registry = createRegistry(db);
});

describe("operation registry", () => {
  it("runs an operation and records success", async () => {
    const op = await registry.start("media", "up", "u1", async (emit) => {
      emit("done\n");
      return 0;
    });
    await registry.wait(op.id);
    const final = registry.get(op.id);
    expect(final?.status).toBe("succeeded");
    expect(final?.exitCode).toBe(0);
  });

  it("records a non-zero exit as failed", async () => {
    const op = await registry.start("media", "up", "u1", async () => 1);
    await registry.wait(op.id);
    expect(registry.get(op.id)?.status).toBe("failed");
  });

  it("records a thrown error as failed rather than leaving it running", async () => {
    const op = await registry.start("media", "up", "u1", async () => {
      throw new Error("boom");
    });
    await registry.wait(op.id);
    expect(registry.get(op.id)?.status).toBe("failed");
  });

  it("rejects a second operation on the same project while one is running", async () => {
    const gate = deferred();
    const first = await registry.start("media", "up", "u1", () => gate.promise);
    await expect(
      registry.start("media", "down", "u1", async () => 0),
    ).rejects.toThrow(/already running/);
    gate.resolve(0);
    await registry.wait(first.id);
  });

  it("allows a second operation once the first finishes", async () => {
    const a = await registry.start("media", "up", "u1", async () => 0);
    await registry.wait(a.id);
    const b = await registry.start("media", "down", "u1", async () => 0);
    await registry.wait(b.id);
    expect(registry.get(b.id)?.status).toBe("succeeded");
  });

  it("allows concurrent operations on different projects", async () => {
    const gate = deferred();
    const a = await registry.start("media", "up", "u1", () => gate.promise);
    const b = await registry.start("paperless", "up", "u1", async () => 0);
    await registry.wait(b.id);
    gate.resolve(0);
    await registry.wait(a.id);
    expect(registry.get(b.id)?.status).toBe("succeeded");
  });

  it("replays buffered output to a late subscriber", async () => {
    const gate = deferred();
    const op = await registry.start("media", "up", "u1", async (emit) => {
      emit("first\n");
      return gate.promise;
    });
    await new Promise((r) => setTimeout(r, 10));
    const seen: string[] = [];
    registry.subscribe(
      op.id,
      (c) => seen.push(c),
      () => {},
    );
    expect(seen.join("")).toContain("first\n");
    gate.resolve(0);
    await registry.wait(op.id);
  });

  it("notifies subscribers when the operation ends and stops after unsubscribe", async () => {
    const gate = deferred();
    let ended = false;
    const seen: string[] = [];
    const op = await registry.start("media", "up", "u1", async (emit) => {
      emit("a\n");
      const code = await gate.promise;
      emit("b\n");
      return code;
    });
    const unsubscribe = registry.subscribe(
      op.id,
      (c) => seen.push(c),
      () => {
        ended = true;
      },
    );
    unsubscribe();
    gate.resolve(0);
    await registry.wait(op.id);
    expect(seen.join("")).toBe("a\n");
    expect(ended).toBe(false);
  });

  it("persists terminal results for history", async () => {
    const op = await registry.start("media", "up", "u1", async (emit) => {
      emit("hello\n");
      return 0;
    });
    await registry.wait(op.id);
    const history = await registry.listForProject("media");
    expect(history[0]).toMatchObject({
      id: op.id,
      status: "succeeded",
      exitCode: 0,
    });
  });

  it("returns history in the shared Operation shape, without output", async () => {
    const op = await registry.start("media", "up", "u1", async (emit) => {
      emit("a lot of output\n");
      return 0;
    });
    await registry.wait(op.id);
    const [row] = await registry.listForProject("media");
    expect(row).toEqual({
      id: op.id,
      slug: "media",
      kind: "up",
      status: "succeeded",
      exitCode: 0,
      startedAt: op.startedAt,
      finishedAt: op.finishedAt,
    });
  });

  it("writes the history row before telling a subscriber the run ended", async () => {
    const gate = deferred();
    const op = await registry.start("media", "up", "u1", () => gate.promise);
    let historyAtEnd: string[] = [];
    const observed = new Promise<void>((resolve) => {
      registry.subscribe(
        op.id,
        () => {},
        () => {
          void registry.listForProject("media").then((rows) => {
            historyAtEnd = rows.map((r) => r.id);
            resolve();
          });
        },
      );
    });
    gate.resolve(0);
    await observed;
    expect(historyAtEnd).toContain(op.id);
  });

  it("finds a finished operation that is no longer held in memory", async () => {
    const gate = deferred();
    const running = await registry.start(
      "proj-running",
      "up",
      "u1",
      () => gate.promise,
    );
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) {
      const op = await registry.start(`proj-${i}`, "up", "u1", async () => 0);
      await registry.wait(op.id);
      ids.push(op.id);
    }
    const evicted = ids[0] ?? "";
    expect(registry.get(evicted)).toBeUndefined();
    expect(await registry.find(evicted)).toMatchObject({
      id: evicted,
      slug: "proj-0",
      status: "succeeded",
    });
    gate.resolve(0);
    await registry.wait(running.id);
  });

  it("finds a still-running operation from memory", async () => {
    const gate = deferred();
    const op = await registry.start("media", "up", "u1", () => gate.promise);
    expect(await registry.find(op.id)).toMatchObject({ status: "running" });
    gate.resolve(0);
    await registry.wait(op.id);
  });

  it("returns undefined for an id that exists nowhere", async () => {
    expect(await registry.find("no-such-operation")).toBeUndefined();
  });

  it("still terminates subscribers when writing the history row fails", async () => {
    // SQLITE_FULL on a NAS is not exotic. With the insert awaited ahead of the
    // fan-out, a rejection stranded every open stream: no terminal event, the
    // subscriber set never cleared, eviction skipped, and `wait` rejecting
    // from inside a `finally` as an unhandled rejection.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === "insert") {
          return () => ({
            values: () =>
              Promise.reject(
                new Error("SQLITE_FULL: database or disk is full"),
              ),
          });
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    const broken = createRegistry(failing);

    const gate = deferred();
    let ended = false;
    const op = await broken.start("media", "up", "u1", () => gate.promise);
    broken.subscribe(
      op.id,
      () => {},
      () => {
        ended = true;
      },
    );
    gate.resolve(0);

    await expect(broken.wait(op.id)).resolves.toBeUndefined();
    expect(ended).toBe(true);
    expect(broken.get(op.id)?.status).toBe("succeeded");
    expect(logged).toHaveBeenCalled();

    // The per-project mutex must have been released despite the failure.
    const next = await broken.start("media", "down", "u1", async () => 0);
    await broken.wait(next.id);

    logged.mockRestore();
  });

  /** ~256 bytes a line, so 8000 lines is comfortably past the 1 MiB cap. */
  const noisy = (emit: (chunk: string) => void) => {
    for (let i = 0; i < 8000; i++) emit(`line-${i} ${"x".repeat(240)}\n`);
  };

  it("keeps the tail when buffer exceeds cap, discarding the head", async () => {
    const op = await registry.start("media", "pull", "u1", async (emit) => {
      noisy(emit);
      return 0;
    });
    await registry.wait(op.id);
    const output = await storedOutput(op.id);
    expect(output).toContain("line-7999");
    expect(output).not.toContain("line-0 ");
  });

  it("bounds the buffer by bytes, not by chunk count", async () => {
    const op = await registry.start("media", "pull", "u1", async (emit) => {
      noisy(emit);
      return 0;
    });
    await registry.wait(op.id);
    const output = await storedOutput(op.id);
    // 8000 * ~250 bytes is ~2 MiB of emitted output; only the cap survives.
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(
      MAX_BUFFER_BYTES + 64,
    );
  });

  it("caps a single chunk larger than the whole buffer", async () => {
    const op = await registry.start("media", "pull", "u1", async (emit) => {
      emit(`HEAD-MARKER\n${"y".repeat(3 * MAX_BUFFER_BYTES)}\nTAIL-MARKER`);
      return 0;
    });
    await registry.wait(op.id);
    const output = await storedOutput(op.id);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(
      MAX_BUFFER_BYTES + 64,
    );
    expect(output).toContain("TAIL-MARKER");
    expect(output).not.toContain("HEAD-MARKER");
  });

  it("shows truncation marker when buffer was trimmed", async () => {
    const op = await registry.start("media", "pull", "u1", async (emit) => {
      noisy(emit);
      return 0;
    });
    await registry.wait(op.id);
    expect(await storedOutput(op.id)).toContain("[earlier output truncated]");
  });

  it("does not show truncation marker when under cap", async () => {
    const op = await registry.start("media", "up", "u1", async (emit) => {
      for (let i = 0; i < 100; i++) {
        emit(`line-${i}\n`);
      }
      return 0;
    });
    await registry.wait(op.id);
    expect(await storedOutput(op.id)).not.toContain("truncated");
  });

  it("evicts oldest finished operation when retention cap exceeded, but keeps running ones", async () => {
    const gate = deferred();
    const running = await registry.start(
      "proj-running",
      "up",
      "u1",
      () => gate.promise,
    );
    const finished: string[] = [];
    for (let i = 0; i < 52; i++) {
      const op = await registry.start(`proj-${i}`, "up", "u1", async () => 0);
      await registry.wait(op.id);
      finished.push(op.id);
    }
    const firstId = finished[0];
    const lastId = finished[51];
    expect(firstId).toBeDefined();
    expect(lastId).toBeDefined();
    expect(registry.get(firstId ?? "")).toBeUndefined();
    expect(registry.get(lastId ?? "")).toBeDefined();
    expect(registry.get(running.id)).toBeDefined();
    gate.resolve(0);
    await registry.wait(running.id);
  });
});
