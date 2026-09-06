import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db, runMigrations } from "./client.js";
import { getSetting, setSetting } from "./settings.js";

let db: Db;
beforeEach(async () => {
  db = createDb(":memory:");
  await runMigrations(db);
});

describe("settings", () => {
  it("returns undefined for a missing key", async () => {
    expect(await getSetting(db, "onboarding_completed")).toBeUndefined();
  });

  it("round-trips a value", async () => {
    await setSetting(db, "onboarding_completed", "true");
    expect(await getSetting(db, "onboarding_completed")).toBe("true");
  });

  it("overwrites an existing key rather than failing", async () => {
    await setSetting(db, "instance_name", "first");
    await setSetting(db, "instance_name", "second");
    expect(await getSetting(db, "instance_name")).toBe("second");
  });
});
