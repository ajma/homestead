import type { Step, StepEvent } from "@server/apps/step-sequence";
import { runSteps } from "@server/apps/step-sequence";
import { describe, expect, it, vi } from "vitest";

type Ctx = { log: string[] };

function step(
  name: string,
  opts: { fail?: boolean; undo?: boolean; undoFails?: boolean } = {},
): Step<Ctx> {
  const s: Step<Ctx> = {
    name,
    run: vi.fn(async (ctx: Ctx) => {
      ctx.log.push(`run:${name}`);
      if (opts.fail) throw new Error(`${name} failed`);
    }),
  };
  if (opts.undo || opts.undoFails) {
    s.undo = vi.fn(async (ctx: Ctx) => {
      ctx.log.push(`undo:${name}`);
      if (opts.undoFails) throw new Error(`${name} undo failed`);
    });
  }
  return s;
}

describe("runSteps", () => {
  it("succeeds when every step succeeds, in order, with no undo called", async () => {
    const a = step("a", { undo: true });
    const b = step("b", { undo: true });
    const c = step("c", { undo: true });
    const ctx: Ctx = { log: [] };

    const outcome = await runSteps([a, b, c], ctx);

    expect(outcome).toEqual({ ok: true, completed: ["a", "b", "c"] });
    expect(a.undo).not.toHaveBeenCalled();
    expect(b.undo).not.toHaveBeenCalled();
    expect(c.undo).not.toHaveBeenCalled();
  });

  it("succeeds trivially for an empty step list", async () => {
    const outcome = await runSteps([], { log: [] });
    expect(outcome).toEqual({ ok: true, completed: [] });
  });

  it("undoes completed steps in reverse order when a later step fails, and never runs the rest", async () => {
    const a = step("a", { undo: true });
    const b = step("b", { undo: true });
    const c = step("c", { fail: true, undo: true });
    const d = step("d", { undo: true });
    const ctx: Ctx = { log: [] };

    const outcome = await runSteps([a, b, c, d], ctx);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.failed).toBe("c");
    expect(outcome.undone).toEqual(["b", "a"]);
    expect(d.run).not.toHaveBeenCalled();
    expect(ctx.log).toEqual(["run:a", "run:b", "run:c", "undo:b", "undo:a"]);
  });

  it("never undoes the failing step itself", async () => {
    // Its `run` did not complete, so undoing it would undo something that never
    // happened — for an idempotent create, that deletes a resource someone else owns.
    const a = step("a", { undo: true });
    const failing = step("failing", { fail: true, undo: true });

    const outcome = await runSteps([a, failing], { log: [] });

    expect(outcome.ok).toBe(false);
    expect(failing.undo).not.toHaveBeenCalled();
    if (!outcome.ok) expect(outcome.undone).not.toContain("failing");
  });

  it("skips a completed step with no undo during rollback, without aborting the walk", async () => {
    const a = step("a", { undo: true });
    const readOnly = step("readOnly"); // no undo — e.g. a read-only lookup step
    const failing = step("failing", { fail: true });

    const outcome = await runSteps([a, readOnly, failing], { log: [] });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.undone).toEqual(["a"]);
      expect(outcome.undoFailures).toEqual([]);
    }
    expect(a.undo).toHaveBeenCalledTimes(1);
  });

  it("continues rolling back the rest when an undo throws, and reports it", async () => {
    // The one that matters most: if undoing step 2 throws, step 1 must still be undone.
    // Otherwise one cleanup failure strands everything before it.
    const a = step("a", { undo: true });
    const b = step("b", { undoFails: true });
    const failing = step("failing", { fail: true });

    const outcome = await runSteps([a, b, failing], { log: [] });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // b's undo threw, so it is not in `undone`, but rollback still reached `a`.
      expect(outcome.undone).toEqual(["a"]);
      expect(outcome.undoFailures).toHaveLength(1);
      expect(outcome.undoFailures[0]?.step).toBe("b");
      expect(outcome.undoFailures[0]?.error).toBeInstanceOf(Error);
    }
    expect(a.undo).toHaveBeenCalledTimes(1);
    expect(b.undo).toHaveBeenCalledTimes(1);
  });

  it("fires onProgress for each step's start and end, including during rollback", async () => {
    const a = step("a", { undo: true });
    const failing = step("failing", { fail: true });
    const events: StepEvent[] = [];

    await runSteps([a, failing], { log: [] }, { onProgress: (event) => events.push(event) });

    expect(events).toEqual([
      { phase: "run", step: "a", stage: "start" },
      { phase: "run", step: "a", stage: "end", ok: true },
      { phase: "run", step: "failing", stage: "start" },
      { phase: "run", step: "failing", stage: "end", ok: false },
      { phase: "undo", step: "a", stage: "start" },
      { phase: "undo", step: "a", stage: "end", ok: true },
    ]);
  });

  it("passes the original error through on the outcome", async () => {
    const boom = new Error("boom");
    const failing: Step<Ctx> = { name: "failing", run: async () => Promise.reject(boom) };

    const outcome = await runSteps([failing], { log: [] });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe(boom);
  });
});
