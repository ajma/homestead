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
  systemKind: null,
  graceUntil: null,
  adoptedAt: 1700000000,
  archivedAt: null,
};

const status = { status: "up" as const, detail: "4/4 services up" };

const extras = {
  lastDeployAt: null,
  runningJobId: null,
  exposureHostname: null,
  uptimeSince: null,
};

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
      "systemKind",
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
    expect(
      toAdminApp(row, status, {
        ...extras,
        lastDeployAt: 1700003600,
        runningJobId: "job-1",
        exposureHostname: "jellyfin.example.com",
        uptimeSince: 1700003000,
      }),
    ).toEqual({
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
      systemKind: null,
      showOnLauncher: true,
      sortOrder: 0,
      graceUntil: null,
      adoptedAt: 1700000000,
      archivedAt: null,
      lastDeployAt: 1700003600,
      runningJobId: "job-1",
      exposureHostname: "jellyfin.example.com",
      uptimeSince: 1700003000,
      ports: [],
    });
  });

  it("passes null through when there is no deploy to report", () => {
    expect(toAdminApp(row, status, extras).lastDeployAt).toBeNull();
  });

  it("passes null through when there is no running job to report", () => {
    expect(toAdminApp(row, status, extras).runningJobId).toBeNull();
  });

  it("passes null through when there is no exposure to report", () => {
    expect(toAdminApp(row, status, extras).exposureHostname).toBeNull();
  });

  it("passes null through when there is no uptime to report", () => {
    expect(toAdminApp(row, status, extras).uptimeSince).toBeNull();
  });

  it("collects, deduplicates and sorts every published port across every service", () => {
    const statusWithServices = {
      ...status,
      services: [
        { name: "web", image: "nginx", restart: null, publishedPorts: [8080, 443] },
        { name: "sidecar", image: "envoy", restart: null, publishedPorts: [443, 22] },
      ],
    };
    expect(toAdminApp(row, statusWithServices, extras).ports).toEqual([22, 443, 8080]);
  });

  it("reports no ports when the status carries no resolved services", () => {
    expect(toAdminApp(row, status, extras).ports).toEqual([]);
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
