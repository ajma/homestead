import {
  ACCESS_TEAM_DOMAIN_SETTING_KEY,
  resolveAccessSettings,
} from "@server/auth/access-settings";
import type { Config } from "@server/config";
import { createDb, runMigrations } from "@server/db/client";
import { apps, exposures, hosts, settings } from "@server/db/schema";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

const HOST_ID = "host-1";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: "test",
    port: 3000,
    secretKey: Buffer.alloc(32, 1),
    dbPath: ":memory:",
    composeRoot: "/compose",
    dockerSocket: "/var/run/docker.sock",
    baseUrl: "https://homestead.example.com",
    trustedOrigins: [],
    trustedProxies: [],
    accessTeamDomain: null,
    accessAud: null,
    accessEnabled: false,
    skipMountPreflight: true,
    iconCacheDir: "/icons",
    ...overrides,
  };
}

async function setup() {
  const { db } = await createDb(":memory:");
  await runMigrations(db);
  await db.insert(hosts).values({
    id: HOST_ID,
    name: "local",
    composeRoot: "/compose",
    dockerSocket: "/var/run/docker.sock",
  });
  return { db };
}

/** Seeds an app marked `systemKind: "self"` with an exposure carrying `aud`, and
 * (unless `withTeamDomain` is false) the team-domain setting alongside it — the shape
 * §10 describes Homestead recording when it provisions its own exposure, even though
 * nothing in the codebase performs that write yet (see `access-settings.ts`'s doc
 * comment). This seeds the end state directly so the RESOLUTION logic can be proven
 * without the (unbuilt) write path. */
async function seedSelfApp(
  db: Awaited<ReturnType<typeof createDb>>["db"],
  opts: { aud?: string | null; teamDomain?: string | null } = {},
) {
  const appId = ulid();
  await db.insert(apps).values({
    id: appId,
    hostId: HOST_ID,
    slug: "homestead",
    displayName: "Homestead",
    directory: "homestead",
    composeFile: "compose.yaml",
    projectName: "homestead",
    systemKind: "self",
  });
  await db.insert(exposures).values({
    id: ulid(),
    appId,
    hostname: "homestead.example.com",
    ingressService: "http://localhost:3000",
    accessAppAud: opts.aud === undefined ? "db-aud-value" : opts.aud,
  });
  if (opts.teamDomain !== null) {
    await db.insert(settings).values({
      key: ACCESS_TEAM_DOMAIN_SETTING_KEY,
      value: opts.teamDomain === undefined ? "db-team" : opts.teamDomain,
    });
  }
  return appId;
}

describe("resolveAccessSettings", () => {
  it("resolves from the database when both values are recorded there", async () => {
    const { db } = await setup();
    await seedSelfApp(db, { aud: "db-aud-value", teamDomain: "db-team" });

    await expect(resolveAccessSettings({ db, config: makeConfig() })).resolves.toEqual({
      teamDomain: "db-team",
      aud: "db-aud-value",
    });
  });

  it("the environment wins when it supplies both values, even with a full database record", async () => {
    const { db } = await setup();
    await seedSelfApp(db, { aud: "db-aud-value", teamDomain: "db-team" });
    const config = makeConfig({ accessTeamDomain: "env-team", accessAud: "env-aud" });

    await expect(resolveAccessSettings({ db, config })).resolves.toEqual({
      teamDomain: "env-team",
      aud: "env-aud",
    });
  });

  it("does not blend a team domain from the environment with an audience from the database", async () => {
    const { db } = await setup();
    // The database supplies only the OTHER half (no team-domain setting written), so a
    // correct implementation cannot complete the pair from either source alone.
    await seedSelfApp(db, { aud: "db-aud-value", teamDomain: null });
    const config = makeConfig({ accessTeamDomain: "env-team", accessAud: null });

    await expect(resolveAccessSettings({ db, config })).resolves.toBeNull();
  });

  it("does not blend an audience from the environment with a team domain from the database", async () => {
    const { db } = await setup();
    // The database supplies only the team domain; its exposure carries no audience yet,
    // so — symmetrically to the test above — neither source completes the pair alone.
    await seedSelfApp(db, { aud: null, teamDomain: "db-team" });
    const config = makeConfig({ accessTeamDomain: null, accessAud: "env-aud" });

    await expect(resolveAccessSettings({ db, config })).resolves.toBeNull();
  });

  it("is null when only the team domain is configured anywhere", async () => {
    const { db } = await setup();
    const config = makeConfig({ accessTeamDomain: "env-team", accessAud: null });

    await expect(resolveAccessSettings({ db, config })).resolves.toBeNull();
  });

  it("is null when only the audience is configured anywhere", async () => {
    const { db } = await setup();
    const config = makeConfig({ accessTeamDomain: null, accessAud: "env-aud" });

    await expect(resolveAccessSettings({ db, config })).resolves.toBeNull();
  });

  it("treats an empty-string environment value as absent, not as configured", async () => {
    const { db } = await setup();
    // Bypasses `loadConfig`'s own `""` -> `null` transform on purpose: this proves
    // `resolveAccessSettings` does not rely solely on that transform having run, the
    // same defence-in-depth `TunnelStore.get()` applies to an empty-string token.
    const config = makeConfig({ accessTeamDomain: "", accessAud: "env-aud" });

    await expect(resolveAccessSettings({ db, config })).resolves.toBeNull();
  });

  it("treats an empty-string database audience as absent, not as configured", async () => {
    const { db } = await setup();
    await seedSelfApp(db, { aud: "", teamDomain: "db-team" });

    await expect(resolveAccessSettings({ db, config: makeConfig() })).resolves.toBeNull();
  });

  it("is null when nothing is configured anywhere", async () => {
    const { db } = await setup();

    await expect(resolveAccessSettings({ db, config: makeConfig() })).resolves.toBeNull();
  });

  it("is null when no app is marked systemKind: self", async () => {
    // The known gap this phase leaves open: nothing assigns `systemKind: "self"` yet,
    // so in production this branch is what actually resolves until a later phase marks
    // one. This test only proves the query returns null gracefully when it is absent.
    const { db } = await setup();

    await expect(resolveAccessSettings({ db, config: makeConfig() })).resolves.toBeNull();
  });

  it("is null when the self app has no exposure yet", async () => {
    const { db } = await setup();
    const appId = ulid();
    await db.insert(apps).values({
      id: appId,
      hostId: HOST_ID,
      slug: "homestead",
      displayName: "Homestead",
      directory: "homestead",
      composeFile: "compose.yaml",
      projectName: "homestead",
      systemKind: "self",
    });

    await expect(resolveAccessSettings({ db, config: makeConfig() })).resolves.toBeNull();
  });

  it("is null when the self app's exposure has no audience yet (still provisioning)", async () => {
    const { db } = await setup();
    await seedSelfApp(db, { aud: null, teamDomain: "db-team" });

    await expect(resolveAccessSettings({ db, config: makeConfig() })).resolves.toBeNull();
  });

  it("is null when the team-domain setting was never written", async () => {
    const { db } = await setup();
    await seedSelfApp(db, { aud: "db-aud-value", teamDomain: null });

    await expect(resolveAccessSettings({ db, config: makeConfig() })).resolves.toBeNull();
  });
});
