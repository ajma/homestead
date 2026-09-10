import { APP_STATUSES, isAppStatus } from "@shared/types";
import { describe, expect, it } from "vitest";

describe("isAppStatus", () => {
  it("accepts every declared status", () => {
    for (const s of APP_STATUSES) expect(isAppStatus(s)).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(isAppStatus("exploded")).toBe(false);
  });
});
