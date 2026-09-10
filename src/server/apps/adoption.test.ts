import { scanForApps } from "@server/apps/adoption";
import { createDb, runMigrations } from "@server/db/client";
import { apps, hosts } from "@server/db/schema";
import type { ContainerSummary } from "@server/host/types";
import { FakeHost } from "@server/test-helpers";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const container = (project: string, service: string, state = "running"): ContainerSummary => ({
  id: ulid(),
  names: [`${project}-${service}`],
  image: "x",
  state,
  status: state === "running" ? "Up 2 hours" : "Exited (0)",
  project,
  service,
  labels: { "com.docker.compose.project": project },
});

async function seed() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await db.insert(hosts).values({
    id: "local",
    name: "local",
    composeRoot: "/volume2/docker",
    dockerSocket: "/var/run/docker.sock",
  });
  return db;
}

function hostWith(dirs: Array<[string, string]>, containers: ContainerSummary[]) {
  const host = new FakeHost();
  for (const [dir, file] of dirs) host.files.set(`${dir}/${file}`, "services: {}\n");
  host.containers = containers;
  return host;
}

describe("scanForApps", () => {
  it("classifies running, stopped, and orphaned stacks", async () => {
    const db = await seed();
    const host = hostWith(
      [
        ["jellyfin", "compose.yaml"],
        ["paperless", "compose.yaml"],
      ],
      [container("jellyfin", "web"), container("jellyfin", "db"), container("ghost", "web")],
    );
    const result = await scanForApps({ db, host, hostId: "local" });

    const jellyfin = result.discovered.find((d) => d.directory === "jellyfin");
    expect(jellyfin).toMatchObject({ containerCount: 2, running: true, adopted: false });

    const paperless = result.discovered.find((d) => d.directory === "paperless");
    expect(paperless).toMatchObject({ containerCount: 0, running: false, adopted: false });

    expect(result.orphans).toEqual([{ projectName: "ghost", containerCount: 1 }]);
  });

  it("marks already-adopted directories so the UI can skip them", async () => {
    const db = await seed();
    await db.insert(apps).values({
      id: ulid(),
      hostId: "local",
      slug: "jellyfin",
      displayName: "Jellyfin",
      directory: "jellyfin",
      composeFile: "compose.yaml",
      projectName: "jellyfin",
    });
    const host = hostWith([["jellyfin", "compose.yaml"]], [container("jellyfin", "web")]);
    const result = await scanForApps({ db, host, hostId: "local" });
    expect(result.discovered.find((d) => d.directory === "jellyfin")?.adopted).toBe(true);
  });

  it("does not report an adopted app as an orphan", async () => {
    const db = await seed();
    await db.insert(apps).values({
      id: ulid(),
      hostId: "local",
      slug: "jellyfin",
      displayName: "Jellyfin",
      directory: "jellyfin",
      composeFile: "compose.yaml",
      projectName: "jellyfin",
    });
    const host = hostWith([["jellyfin", "compose.yaml"]], [container("jellyfin", "web")]);
    expect((await scanForApps({ db, host, hostId: "local" })).orphans).toEqual([]);
  });

  it("counts stopped containers but does not call the stack running", async () => {
    const db = await seed();
    const host = hostWith(
      [["immich", "compose.yaml"]],
      [container("immich", "web", "exited"), container("immich", "db", "exited")],
    );
    const result = await scanForApps({ db, host, hostId: "local" });
    expect(result.discovered[0]).toMatchObject({ containerCount: 2, running: false });
  });

  it("returns empty results for an empty compose root", async () => {
    const db = await seed();
    const result = await scanForApps({ db, host: hostWith([], []), hostId: "local" });
    expect(result).toEqual({ discovered: [], orphans: [] });
  });

  it("normalises the directory name the way compose does", async () => {
    // `My Media` runs as project `mymedia`. Comparing the raw name matches nothing, and
    // the failure is doubled: the stack reads as stopped AND its containers show up as
    // an orphan, so one real directory produces two wrong rows.
    const db = await seed();
    const host = hostWith([["My Media", "compose.yaml"]], [container("mymedia", "web")]);
    const result = await scanForApps({ db, host, hostId: "local" });
    expect(result.discovered[0]).toMatchObject({
      directory: "My Media",
      projectName: "mymedia",
      containerCount: 1,
      running: true,
    });
    expect(result.orphans).toEqual([]);
  });

  it("honours COMPOSE_PROJECT_NAME from the sibling .env", async () => {
    const db = await seed();
    const host = hostWith([["stack", "compose.yaml"]], [container("custom-name", "web")]);
    host.files.set("stack/.env", "# set by the tutorial\nCOMPOSE_PROJECT_NAME=custom-name\n");
    const result = await scanForApps({ db, host, hostId: "local" });
    expect(result.discovered[0]).toMatchObject({
      projectName: "custom-name",
      containerCount: 1,
      running: true,
    });
    expect(result.orphans).toEqual([]);
  });

  it("ignores a .env that sets COMPOSE_PROJECT_NAME to nothing", async () => {
    const db = await seed();
    const host = hostWith([["stack", "compose.yaml"]], [container("stack", "web")]);
    host.files.set("stack/.env", "COMPOSE_PROJECT_NAME=\n");
    const result = await scanForApps({ db, host, hostId: "local" });
    expect(result.discovered[0]).toMatchObject({ projectName: "stack", containerCount: 1 });
  });

  it("prefers an adopted app's recorded name over what .env now says", async () => {
    // Adoption resolved the name through the CLI, so it is authoritative even if
    // someone edits .env afterwards without recreating the containers.
    const db = await seed();
    await db.insert(apps).values({
      id: ulid(),
      hostId: "local",
      slug: "stack",
      displayName: "Stack",
      directory: "stack",
      composeFile: "compose.yaml",
      projectName: "recorded",
    });
    const host = hostWith([["stack", "compose.yaml"]], [container("recorded", "web")]);
    host.files.set("stack/.env", "COMPOSE_PROJECT_NAME=changed-since\n");
    const result = await scanForApps({ db, host, hostId: "local" });
    expect(result.discovered[0]).toMatchObject({ projectName: "recorded", containerCount: 1 });
    expect(result.orphans).toEqual([]);
  });
});
