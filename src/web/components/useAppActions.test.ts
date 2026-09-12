import { ApiError, ApiTimeoutError } from "@web/api/client";
import { describeActionError } from "@web/components/useAppActions";
import { describe, expect, it } from "vitest";

describe("describeActionError", () => {
  it("surfaces the server's own message for the ordinary already-running 409", () => {
    const error = new ApiError(409, {
      error: "job_running",
      message: "Another job is already running for this app.",
      runningJobId: "j1",
    });

    expect(describeActionError(error)).toBe("Another job is already running for this app.");
  });

  it("surfaces the server's honest holder-naming message, not a hard-coded one", () => {
    // `routes/jobs.ts` sends this exact shape when the lock is held by something that
    // shares it (a step job) rather than by this runner's own job — no `runningJobId` to
    // give, so it names the holder instead. Before this fix, `describeActionError` threw
    // this string away and always returned the generic constant (Phase 2B whole-branch
    // review, Minor 7): the server built an honest message and the client discarded it.
    const error = new ApiError(409, {
      error: "job_running",
      message: "This app is busy: cloudflare_expose job.",
    });

    expect(describeActionError(error)).toBe("This app is busy: cloudflare_expose job.");
  });

  it("falls back to the generic message when a 409 body has none", () => {
    const error = new ApiError(409, { error: "job_running" });

    expect(describeActionError(error)).toBe("Another job is already running for this app.");
  });

  it("reports a timeout distinctly from a rejection", () => {
    expect(describeActionError(new ApiTimeoutError(30_000))).toMatch(/did not respond/i);
  });

  it("falls back to the error's own message for anything else", () => {
    expect(describeActionError(new Error("boom"))).toBe("boom");
  });

  it("falls back to a generic message for a non-Error throw", () => {
    expect(describeActionError("boom")).toBe("Could not start this action.");
  });
});
