import { auditLog } from "@server/db/schema";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const VALID = JSON.stringify({ name: "jellyfin", services: { web: { image: "nginx" } } });
const ENV = "# Database\nDB_PASSWORD=hunter2\nPUID=1000\n";

async function withEnv() {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
  app.deps.host.files.set("jellyfin/.env", ENV);
  app.deps.host.composeResults.set("config --format json", {
    exitCode: 0,
    stdout: VALID,
    stderr: "",
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/apps/adopt",
    headers: { cookie },
    payload: { directories: ["jellyfin"] },
  });
  return { app, cookie, id: res.json().adopted[0].id as string };
}

describe(".env API", () => {
  it("returns keys with masked values and never the secret", async () => {
    const { app, cookie, id } = await withEnv();
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
    });
    expect(res.body).not.toContain("hunter2");
    expect(res.json().entries).toEqual([
      { key: "DB_PASSWORD", masked: "••••••••" },
      { key: "PUID", masked: "••••••••" },
    ]);
    await app.close();
  });

  it("refuses a viewer entirely, rather than returning a masked file", async () => {
    const { app, cookie, id } = await withEnv();
    const viewer = await createViewer(app, cookie);
    for (const url of [`/api/apps/${id}/env`]) {
      expect(
        (await app.inject({ method: "GET", url, headers: { cookie: viewer.cookie } })).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/apps/${id}/env/reveal`,
          headers: { cookie: viewer.cookie },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });

  it("reveals values only through the explicit endpoint, and audits it", async () => {
    const { app, cookie, id } = await withEnv();
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
    });
    expect(res.json().content).toContain("hunter2");

    const entries = await app.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "app.env_revealed"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.targetId).toBe(id);
    await app.close();
  });

  it("refuses to touch a .env it cannot read, rather than replacing it", async () => {
    // The worst outcome available here. `.env` files are routinely chmod 600, so a
    // Homestead running as another uid gets EACCES — and if that read short-circuits to
    // "no .env", the user writes one with expectedHash null, writeTextFile's own read
    // fails the same way, currentHash comes out null, the guard matches, and the
    // original file full of database passwords is gone.
    const { app, cookie, id } = await withEnv();
    const denied = new Error("EACCES: permission denied, open");
    app.deps.host.readTextFileErrors.set("jellyfin/.env", denied);

    const get = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(409);
    expect(get.json().error).toBe("env_unreadable");

    const reveal = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
    });
    expect(reveal.statusCode).toBe(409);

    const put = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { content: "REPLACED=yes\n", expectedHash: null },
    });
    expect(put.statusCode).toBe(409);
    // The point of the whole test: the original content is still there.
    expect(app.deps.host.files.get("jellyfin/.env")).toBe(ENV);
    await app.close();
  });

  it("does not audit a reveal that did not happen", async () => {
    const { app, cookie, id } = await withEnv();
    app.deps.host.readTextFileErrors.set("jellyfin/.env", new Error("EACCES"));
    await app.inject({ method: "POST", url: `/api/apps/${id}/env/reveal`, headers: { cookie } });
    const entries = await app.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "app.env_revealed"));
    // An audit line claiming a secret was revealed when it was not is worse than none.
    expect(entries).toEqual([]);
    await app.close();
  });

  it("writes the content byte for byte", async () => {
    // The route writes verbatim, so this pins that nothing starts reformatting it —
    // Task 5's parser exists precisely because a round trip through it must be lossless,
    // and the moment this route parses and re-serialises, that becomes load-bearing.
    const { app, cookie, id } = await withEnv();
    const revealed = (
      await app.inject({
        method: "POST",
        url: `/api/apps/${id}/env/reveal`,
        headers: { cookie },
      })
    ).json();
    const content = '# keep me\r\nA="has spaces"   # note\r\n\r\nB=\r\n';
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { content, expectedHash: revealed.hash },
    });
    expect(res.statusCode).toBe(200);
    expect(app.deps.host.files.get("jellyfin/.env")).toBe(content);
    await app.close();
  });

  it("preserves comments and ordering on write", async () => {
    const { app, cookie, id } = await withEnv();
    const revealed = (
      await app.inject({
        method: "POST",
        url: `/api/apps/${id}/env/reveal`,
        headers: { cookie },
      })
    ).json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { content: ENV.replace("PUID=1000", "PUID=1001"), expectedHash: revealed.hash },
    });
    expect(res.statusCode).toBe(200);
    const saved = app.deps.host.files.get("jellyfin/.env") ?? "";
    expect(saved).toContain("# Database");
    expect(saved).toContain("PUID=1001");
    expect(saved.indexOf("DB_PASSWORD")).toBeLessThan(saved.indexOf("PUID"));
    await app.close();
  });

  it("reports an absent .env as empty rather than 404", async () => {
    const { app, cookie, id } = await withEnv();
    app.deps.host.files.delete("jellyfin/.env");
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [], exists: false });
    await app.close();
  });

  it("reconciles projectName after writing COMPOSE_PROJECT_NAME to .env", async () => {
    // projectName is resolved once at adoption, then never revisited. Adding
    // COMPOSE_PROJECT_NAME=other to .env leaves the row saying the old name, so
    // listContainers({ project }) matches nothing and a healthy stack reads down.
    const { app, cookie, id } = await withEnv();

    // Get the current hash.
    const revealed = (
      await app.inject({
        method: "POST",
        url: `/api/apps/${id}/env/reveal`,
        headers: { cookie },
      })
    ).json();

    // Set up containers for the new project name.
    app.deps.host.containers = [
      {
        id: "abc",
        names: ["/other-web-1"],
        image: "nginx",
        labels: {},
        state: "running",
        status: "Up",
        service: "web",
        project: "other",
      },
    ];

    // Write .env with new project name.
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: JSON.stringify({ name: "other", services: { web: { image: "nginx" } } }),
      stderr: "",
    });

    const write = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { content: "COMPOSE_PROJECT_NAME=other\n", expectedHash: revealed.hash },
    });
    expect(write.statusCode).toBe(200);

    // The app row's projectName should have been updated.
    const detail = await app.inject({
      method: "GET",
      url: `/api/apps/${id}`,
      headers: { cookie },
    });
    expect(detail.json().projectName).toBe("other");

    // And the status should find containers under the new name.
    expect(detail.json().status).toBe("up");

    await app.close();
  });
});
