import { AppLock } from "@server/apps/app-lock";
import { describe, expect, it } from "vitest";

describe("AppLock", () => {
  it("refuses a second acquire while held, and allows one after release", () => {
    const lock = new AppLock();
    expect(lock.tryAcquire("app-1", "up job")).toBe(true);
    expect(lock.tryAcquire("app-1", "down job")).toBe(false);

    lock.release("app-1");
    expect(lock.tryAcquire("app-1", "restart job")).toBe(true);
  });

  it("does not let different apps block each other", () => {
    const lock = new AppLock();
    expect(lock.tryAcquire("app-1", "up job")).toBe(true);
    expect(lock.tryAcquire("app-2", "up job")).toBe(true);
  });

  it("names the holder", () => {
    const lock = new AppLock();
    lock.tryAcquire("app-1", "pull job");
    expect(lock.heldBy("app-1")).toBe("pull job");
  });

  it("says nothing is held for an app that was never acquired", () => {
    const lock = new AppLock();
    expect(lock.heldBy("app-1")).toBeUndefined();
  });

  it("releasing an app that was never held is a no-op, not a throw", () => {
    const lock = new AppLock();
    expect(() => lock.release("never-held")).not.toThrow();
  });

  // The test that matters: no `await` between the two calls, so both execute in the
  // same synchronous tick. A `tryAcquire` with any internal `await` would let both
  // calls read the map before either's write lands, and this would (wrongly) pass.
  it("holds against two tryAcquire calls in the same synchronous tick", () => {
    const lock = new AppLock();
    const results = [lock.tryAcquire("app-1", "up job"), lock.tryAcquire("app-1", "down job")];
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
