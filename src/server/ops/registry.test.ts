import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, runMigrations } from "../db/client.js";
import { createRegistry } from "./registry.js";

let db: Db;
let registry: ReturnType<typeof createRegistry>;

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

  it("keeps the tail when buffer exceeds cap, discarding the head", async () => {
    const op = await registry.start("media", "pull", "u1", async (emit) => {
      for (let i = 0; i < 6000; i++) {
        emit(`line-${i}\n`);
      }
      return 0;
    });
    await registry.wait(op.id);
    const history = await registry.listForProject("media");
    expect(history[0]).toBeDefined();
    const output = history[0]?.output ?? "";
    expect(output).toContain("line-5999");
    expect(output).not.toContain("line-0");
  });

  it("shows truncation marker when buffer was trimmed", async () => {
    const op = await registry.start("media", "pull", "u1", async (emit) => {
      for (let i = 0; i < 6000; i++) {
        emit(`line-${i}\n`);
      }
      return 0;
    });
    await registry.wait(op.id);
    const history = await registry.listForProject("media");
    expect(history[0]).toBeDefined();
    expect(history[0]?.output).toContain("[earlier output truncated]");
  });

  it("does not show truncation marker when under cap", async () => {
    const op = await registry.start("media", "up", "u1", async (emit) => {
      for (let i = 0; i < 100; i++) {
        emit(`line-${i}\n`);
      }
      return 0;
    });
    await registry.wait(op.id);
    const history = await registry.listForProject("media");
    expect(history[0]).toBeDefined();
    expect(history[0]?.output).not.toContain("truncated");
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
