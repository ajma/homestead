import { toAdminApp, toViewerApp } from "@server/apps/serialize";
import { describe, expect, it } from "vitest";

const row = {
  id: "app-1",
  hostId: "local",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: "Movies and TV",
  iconRef: "jellyfin",
  category: "Media",
  sortOrder: 0,
  showOnLauncher: true,
  directory: "jellyfin",
  composeFile: "compose.yaml",
  projectName: "jellyfin",
  launchInternalUrl: "http://nas.local:8096",
  lastComposeHash: "abc123",
  isSystem: false,
  graceUntil: null,
  adoptedAt: 1700000000,
  archivedAt: null,
};

const status = { status: "up" as const, detail: "4/4 services up" };

describe("app serializers", () => {
  it("gives a viewer only what a housemate needs", () => {
    const dto = toViewerApp(row, status);
    expect(dto).toEqual({
      id: "app-1",
      slug: "jellyfin",
      displayName: "Jellyfin",
      description: "Movies and TV",
      iconRef: "jellyfin",
      category: "Media",
      launchUrl: "http://nas.local:8096",
      status: "up",
      statusDetail: "4/4 services up",
    });
  });

  it("omits every operational field from the viewer DTO", () => {
    const dto = toViewerApp(row, status) as Record<string, unknown>;
    // All eleven admin-only fields, not a sample. This test's name promises
    // completeness, and it is the backstop if the exact-key-set test below is ever
    // relaxed to reduce its (deliberate) maintenance friction.
    for (const forbidden of [
      "directory",
      "composeFile",
      "projectName",
      "lastComposeHash",
      "hostId",
      "isSystem",
      "graceUntil",
      "adoptedAt",
      "showOnLauncher",
      "sortOrder",
      "archivedAt",
    ]) {
      expect(dto).not.toHaveProperty(forbidden);
    }
  });

  it("serialises the whole row for an admin", () => {
    // Full shape, not spot-checks: a missing admin field would otherwise pass.
    expect(toAdminApp(row, status, 1700003600, "job-1")).toEqual({
      id: "app-1",
      slug: "jellyfin",
      displayName: "Jellyfin",
      description: "Movies and TV",
      iconRef: "jellyfin",
      category: "Media",
      launchUrl: "http://nas.local:8096",
      status: "up",
      statusDetail: "4/4 services up",
      hostId: "local",
      directory: "jellyfin",
      composeFile: "compose.yaml",
      projectName: "jellyfin",
      lastComposeHash: "abc123",
      isSystem: false,
      showOnLauncher: true,
      sortOrder: 0,
      graceUntil: null,
      adoptedAt: 1700000000,
      archivedAt: null,
      lastDeployAt: 1700003600,
      runningJobId: "job-1",
    });
  });

  it("passes null through when there is no deploy to report", () => {
    expect(toAdminApp(row, status, null, null).lastDeployAt).toBeNull();
  });

  it("passes null through when there is no running job to report", () => {
    expect(toAdminApp(row, status, null, null).runningJobId).toBeNull();
  });

  // A new column must not silently reach viewers. This is the guard that makes the
  // "distinct type, not a filter" requirement mean something.
  it("does not widen the viewer DTO when the row gains a field", () => {
    const widened = { ...row, secretOperationalField: "must not leak" };
    const dto = toViewerApp(widened, status) as Record<string, unknown>;
    expect(dto).not.toHaveProperty("secretOperationalField");
    expect(Object.keys(dto).sort()).toEqual([
      "category",
      "description",
      "displayName",
      "iconRef",
      "id",
      "launchUrl",
      "slug",
      "status",
      "statusDetail",
    ]);
  });
});
