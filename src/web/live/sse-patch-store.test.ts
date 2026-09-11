import type { LauncherApp, ProbeSnapshot } from "@shared/launcher";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingPatches, clearPendingPatchesForTest, recordPatch } from "./sse-patch-store";

const probe = (over: Partial<ProbeSnapshot> = {}): ProbeSnapshot => ({
  probeId: "p1",
  kind: "docker",
  label: null,
  status: "up",
  faultClass: null,
  statusSince: 100,
  lastCheckedAt: 100,
  ...over,
});

const tile = (over: Partial<LauncherApp> = {}): LauncherApp => ({
  id: "a1",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: null,
  iconRef: null,
  category: null,
  launchUrl: null,
  sortOrder: 0,
  status: "up",
  reason: "Healthy",
  since: 100,
  probes: [probe()],
  ...over,
});

describe("sse-patch-store", () => {
  afterEach(() => {
    clearPendingPatchesForTest();
  });

  it("leaves the apps untouched when nothing is pending", () => {
    const apps = [tile()];
    expect(applyPendingPatches(apps, 0)).toBe(apps);
  });

  it("re-applies a patch newer than the fetch's start", () => {
    recordPatch("p1", {
      appId: "a1",
      status: "down",
      faultClass: "app",
      statusSince: 500,
      patchedAt: 1000,
    });
    const [patched] = applyPendingPatches([tile()], 500);
    expect(patched).toMatchObject({ status: "down", reason: "Containers not running" });
    expect(patched?.probes[0]).toMatchObject({
      status: "down",
      faultClass: "app",
      statusSince: 500,
    });
  });

  it("leaves the fetched value alone when the patch predates the fetch", () => {
    recordPatch("p1", {
      appId: "a1",
      status: "down",
      faultClass: "app",
      statusSince: 500,
      patchedAt: 100,
    });
    const fetched = tile({ probes: [probe({ status: "up" })], status: "up", reason: "Healthy" });
    const [result] = applyPendingPatches([fetched], 1000);
    expect(result).toBe(fetched);
  });

  it("prunes a patch once a fetch that started after it has been merged", () => {
    recordPatch("p1", {
      appId: "a1",
      status: "down",
      faultClass: "app",
      statusSince: 500,
      patchedAt: 100,
    });
    applyPendingPatches([tile()], 1000);
    // A second, later fetch must not still be racing against the old patch.
    const second = tile({ probes: [probe({ status: "up" })], status: "up", reason: "Healthy" });
    const [result] = applyPendingPatches([second], 2000);
    expect(result).toBe(second);
  });

  it("only patches the matching app, not a same-probe-id collision on another one", () => {
    recordPatch("p1", {
      appId: "other-app",
      status: "down",
      faultClass: "app",
      statusSince: 500,
      patchedAt: 1000,
    });
    const apps = [tile()];
    expect(applyPendingPatches(apps, 500)).toBe(apps);
  });
});
