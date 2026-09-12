import { auditLog } from "@server/db/schema";
import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const VALID = JSON.stringify({ name: "jellyfin", services: { web: { image: "nginx" } } });
const ENV = "# Database\nDB_PASSWORD=hunter2\nPUID=1000\n";

async function withEnv(content: string = ENV) {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
  app.deps.host.files.set("jellyfin/.env", content);
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
  return { app, cookie, id: res.json().adopted[0].id as string, db: app.deps.db };
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
    const body = res.json();
    expect(body.entries).toEqual([
      { key: "DB_PASSWORD", masked: "••••••••" },
      { key: "PUID", masked: "••••••••" },
    ]);
    // The hash rides along with the masked list — nothing secret about it — so a
    // table-mode save can guard a `changes` PUT with it without fetching the whole file
    // first just to learn what to guard against.
    expect(typeof body.hash).toBe("string");
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

  it("marks a whole-file reveal with a scope, so it reads differently from a per-key one", async () => {
    // The whole-file branch and the per-key branch write the same action name — without
    // a `detail` telling them apart, an admin who only ever revealed one row and a table
    // save (which fetches the whole file to reapply changed keys — see `EnvTab.tsx`)
    // produce an audit trail indistinguishable from someone deliberately dumping every
    // secret in Raw mode.
    const { app, cookie, id } = await withEnv();
    await app.inject({ method: "POST", url: `/api/apps/${id}/env/reveal`, headers: { cookie } });
    await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
      payload: { key: "DB_PASSWORD" },
    });

    const entries = await app.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "app.env_revealed"));
    expect(entries).toHaveLength(2);
    expect(entries[0]?.detail).toEqual({ scope: "all" });
    expect(entries[1]?.detail).toEqual({ key: "DB_PASSWORD" });
    await app.close();
  });

  it("records why a whole-file reveal happened, so a raw-mode dump reads differently from a save's merge fetch", async () => {
    // `detail: { scope: "all" }` alone told a whole-file reveal apart from a per-key one,
    // but not the two whole-file callers from EACH OTHER: a deliberate Raw-mode dump and
    // the fetch a table save makes to reapply changed keys both hit this same branch and,
    // without a `reason`, wrote byte-identical audit rows.
    const { app, cookie, id } = await withEnv();
    await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
      payload: { reason: "raw-edit" },
    });
    await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
      payload: { reason: "save-merge" },
    });

    const entries = await app.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "app.env_revealed"));
    expect(entries).toHaveLength(2);
    expect(entries[0]?.detail).toEqual({ scope: "all", reason: "raw-edit" });
    expect(entries[1]?.detail).toEqual({ scope: "all", reason: "save-merge" });
    await app.close();
  });

  it("rejects a reason outside the closed set, rather than letting free text into an audit row", async () => {
    const { app, cookie, id } = await withEnv();
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
      payload: { reason: "because I felt like it" },
    });
    expect(res.statusCode).toBe(400);

    const entries = await app.deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "app.env_revealed"));
    expect(entries).toHaveLength(0);
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
    expect(res.json()).toEqual({ entries: [], exists: false, hash: null });
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

describe("POST /api/apps/:id/env/reveal with a key", () => {
  it("returns just that key's value", async () => {
    const { app, cookie, id } = await withEnv("API_KEY=sk-live-123\nOTHER=zzz\n");
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
      payload: { key: "API_KEY" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ key: "API_KEY", value: "sk-live-123" });
  });

  it("does not include any other key's value in the response", async () => {
    // The whole point of per-key reveal: showing one row must not ship the rest to the
    // browser, where they sit in memory and in the devtools network pane.
    const { app, cookie, id } = await withEnv("API_KEY=sk-live-123\nOTHER=secret-two\n");
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
      payload: { key: "API_KEY" },
    });
    expect(res.body).not.toContain("secret-two");
  });

  it("records which key was revealed, not merely that something was", async () => {
    const { app, cookie, id, db } = await withEnv("API_KEY=sk-live-123\n");
    await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
      payload: { key: "API_KEY" },
    });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "app.env_revealed"));
    expect(JSON.stringify(entry?.detail)).toContain("API_KEY");
  });

  it("404s a key that is not in the file, without saying what is", async () => {
    const { app, cookie, id, db } = await withEnv("API_KEY=x\n");
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
      payload: { key: "NOPE" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("key_not_found");
    expect(res.body).not.toContain("API_KEY");
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "app.env_revealed"));
    // An audit line claiming a key was revealed when it was not is worse than none.
    expect(entries).toEqual([]);
  });

  it("still returns the whole file when no key is given, for raw mode", async () => {
    const { app, cookie, id } = await withEnv("API_KEY=x\nOTHER=y\n");
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
      payload: {},
    });
    expect(res.json().content).toContain("OTHER=y");
  });

  it("requires app:secrets, like the whole-file mode", async () => {
    const { app, cookie, id } = await withEnv("API_KEY=x\n");
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie: viewer.cookie },
      payload: { key: "API_KEY" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("reveal with a duplicated key", () => {
  it("shows the value the container will actually use, not the first one", async () => {
    // dotenv and compose both take the last occurrence. `upsertEnv` already uses
    // findLastIndex for exactly this reason, with a docstring recording the measured
    // incident where rewriting the first was a silent no-op. Reveal has to agree, or an
    // admin checking a secret is shown one value while the container runs another.
    const { app, cookie, id } = await withEnv("API_KEY=old-value\nAPI_KEY=live-value\n");
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/env/reveal`,
      headers: { cookie },
      payload: { key: "API_KEY" },
    });
    expect(res.json()).toEqual({ key: "API_KEY", value: "live-value" });
  });
});

/** The hash `GET .../env` reports right now — what a table save guards a `changes` PUT with. */
async function currentHash(
  app: Awaited<ReturnType<typeof withEnv>>["app"],
  cookie: string,
  id: string,
) {
  const res = await app.inject({ method: "GET", url: `/api/apps/${id}/env`, headers: { cookie } });
  return res.json().hash as string;
}

describe("PUT /api/apps/:id/env with changes", () => {
  it("applies each key through upsertEnv, preserving every comment and untouched line byte-for-byte", async () => {
    // The carried finding this task closes: a table save used to fetch the whole file to
    // run `upsertEnv` in the browser. Now the route does it, against its own read of the
    // file, and the caller sends only the keys it actually touched.
    const { app, cookie, id } = await withEnv();
    const hash = await currentHash(app, cookie, id);
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { changes: [{ key: "PUID", value: "1001" }], expectedHash: hash },
    });
    expect(res.statusCode).toBe(200);
    expect(app.deps.host.files.get("jellyfin/.env")).toBe(
      "# Database\nDB_PASSWORD=hunter2\nPUID=1001\n",
    );
    await app.close();
  });

  it("deletes a key when its change carries a null value", async () => {
    const { app, cookie, id } = await withEnv();
    const hash = await currentHash(app, cookie, id);
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { changes: [{ key: "PUID", value: null }], expectedHash: hash },
    });
    expect(res.statusCode).toBe(200);
    expect(app.deps.host.files.get("jellyfin/.env")).toBe("# Database\nDB_PASSWORD=hunter2\n");
    await app.close();
  });

  it("distinguishes a delete from setting a key to an empty string", async () => {
    const { app, cookie, id } = await withEnv();
    const hash = await currentHash(app, cookie, id);
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { changes: [{ key: "PUID", value: "" }], expectedHash: hash },
    });
    expect(res.statusCode).toBe(200);
    // Still present, just empty — not removed the way `value: null` would remove it.
    expect(app.deps.host.files.get("jellyfin/.env")).toBe(
      "# Database\nDB_PASSWORD=hunter2\nPUID=\n",
    );
    await app.close();
  });

  it("adds a key that was not previously in the file", async () => {
    const { app, cookie, id } = await withEnv();
    const hash = await currentHash(app, cookie, id);
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { changes: [{ key: "TZ", value: "Europe/London" }], expectedHash: hash },
    });
    expect(res.statusCode).toBe(200);
    expect(app.deps.host.files.get("jellyfin/.env")).toBe(
      "# Database\nDB_PASSWORD=hunter2\nPUID=1000\nTZ=Europe/London\n",
    );
    await app.close();
  });

  it("still enforces the hash guard, 409ing on a mismatch", async () => {
    const { app, cookie, id } = await withEnv();
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { changes: [{ key: "PUID", value: "1001" }], expectedHash: "not-the-real-hash" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("stale_hash");
    // Refused, not partially applied.
    expect(app.deps.host.files.get("jellyfin/.env")).toBe(ENV);
    await app.close();
  });

  it("still refuses a .env it cannot read, rather than applying changes blind", async () => {
    const { app, cookie, id } = await withEnv();
    app.deps.host.readTextFileErrors.set("jellyfin/.env", new Error("EACCES: permission denied"));
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { changes: [{ key: "PUID", value: "1001" }], expectedHash: null },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("env_unreadable");
    await app.close();
  });

  it("rejects content and changes sent together, rather than guessing which was meant", async () => {
    const { app, cookie, id } = await withEnv();
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: {
        content: "SOMETHING=else\n",
        changes: [{ key: "PUID", value: "1001" }],
        expectedHash: null,
      },
    });
    expect(res.statusCode).toBe(400);
    // Refused before touching the file.
    expect(app.deps.host.files.get("jellyfin/.env")).toBe(ENV);
    await app.close();
  });

  it("rejects a body with neither content nor changes", async () => {
    const { app, cookie, id } = await withEnv();
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { expectedHash: null },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("treats an empty changes array as a no-op, not an instruction to empty the file", async () => {
    const { app, cookie, id } = await withEnv();
    const hash = await currentHash(app, cookie, id);
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { changes: [], expectedHash: hash },
    });
    expect(res.statusCode).toBe(200);
    expect(app.deps.host.files.get("jellyfin/.env")).toBe(ENV);
    await app.close();
  });

  it("applies changes in order against the freshly-read file, rewriting the LAST occurrence of a duplicated key", async () => {
    const { app, cookie, id } = await withEnv("API_KEY=old-value\nAPI_KEY=live-value\n");
    const hash = await currentHash(app, cookie, id);
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/env`,
      headers: { cookie },
      payload: { changes: [{ key: "API_KEY", value: "rotated" }], expectedHash: hash },
    });
    expect(res.statusCode).toBe(200);
    expect(app.deps.host.files.get("jellyfin/.env")).toBe("API_KEY=old-value\nAPI_KEY=rotated\n");
    await app.close();
  });
});
