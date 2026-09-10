import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

const VALID = JSON.stringify({ name: "jellyfin", services: { web: { image: "nginx" } } });

async function withAdoptedApp() {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  app.deps.host.files.set("jellyfin/compose.yaml", "services:\n  web:\n    image: nginx\n");
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

describe("compose file API", () => {
  it("returns the file with its hash", async () => {
    const { app, cookie, id } = await withAdoptedApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/compose`,
      headers: { cookie },
    });
    expect(res.json().content).toContain("image: nginx");
    expect(res.json().hash).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it("refuses to show the file to a viewer", async () => {
    const { app, cookie, id } = await withAdoptedApp();
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/compose`,
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("writes when the hash matches and updates the recorded hash", async () => {
    const { app, cookie, id } = await withAdoptedApp();
    const before = (
      await app.inject({ method: "GET", url: `/api/apps/${id}/compose`, headers: { cookie } })
    ).json();
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/compose`,
      headers: { cookie },
      payload: {
        content: "services:\n  web:\n    image: nginx:alpine\n",
        expectedHash: before.hash,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hash).not.toBe(before.hash);
    await app.close();
  });

  it("rejects a write whose hash is stale", async () => {
    const { app, cookie, id } = await withAdoptedApp();
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/compose`,
      headers: { cookie },
      payload: { content: "services: {}\n", expectedHash: "f".repeat(64) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("stale_hash");
    await app.close();
  });

  it("rejects a write that would produce an invalid compose file, without saving it", async () => {
    const { app, cookie, id } = await withAdoptedApp();
    const before = (
      await app.inject({ method: "GET", url: `/api/apps/${id}/compose`, headers: { cookie } })
    ).json();
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: 'service "web" depends on undefined service "ghost"',
    });
    const res = await app.inject({
      method: "PUT",
      url: `/api/apps/${id}/compose`,
      headers: { cookie },
      payload: {
        content: "services:\n  web:\n    depends_on: [ghost]\n",
        expectedHash: before.hash,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain("ghost");
    // The original file must be untouched.
    expect(app.deps.host.files.get("jellyfin/compose.yaml")).toContain("image: nginx");
    await app.close();
  });

  it("validates without saving", async () => {
    const { app, cookie, id } = await withAdoptedApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/compose/validate`,
      headers: { cookie },
      payload: { content: "services:\n  web:\n    image: nginx\n" },
    });
    expect(res.json().valid).toBe(true);
    await app.close();
  });

  it("leaves no scratch file behind, on either outcome", async () => {
    // The compose root is an SMB share the user browses. A stray
    // `.homestead-validate-*.yaml` beside their compose file is litter they would have
    // to clean up by hand, and it appears once per keystroke on a debounced editor.
    const { app, cookie, id } = await withAdoptedApp();
    const validate = (content: string) =>
      app.inject({
        method: "POST",
        url: `/api/apps/${id}/compose/validate`,
        headers: { cookie },
        payload: { content },
      });

    await validate("services:\n  web:\n    image: nginx\n");
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: "bad",
    });
    await validate("nonsense\n");

    const strays = [...app.deps.host.files.keys()].filter((f) => f.includes("homestead-validate"));
    expect(strays).toEqual([]);
    await app.close();
  });

  it("does not let two concurrent validations collide", async () => {
    // A debounced editor issues overlapping requests as a matter of course. With one
    // fixed scratch filename the first request's cleanup deleted the file the second
    // was still resolving, and each validation left a permanent cache entry behind.
    const { app, cookie, id } = await withAdoptedApp();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.inject({
          method: "POST",
          url: `/api/apps/${id}/compose/validate`,
          headers: { cookie },
          payload: { content: `services:\n  web:\n    image: nginx:${i}\n` },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(results.every((r) => r.json().valid)).toBe(true);
    expect([...app.deps.host.files.keys()].filter((f) => f.includes("homestead-validate"))).toEqual(
      [],
    );
    await app.close();
  });

  it("does not mask validation errors with cleanup errors", async () => {
    // If cleanup throws in the finally block it replaces whatever the try block was
    // reporting, so a failed validation would surface as a filesystem error instead
    // of the compose message the user needs to see.
    const { app, cookie, id } = await withAdoptedApp();
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 1,
      stdout: "",
      stderr: 'service "web" depends on undefined service "db"',
    });

    // Make cleanup fail for all scratch files by overriding deleteFile.
    const originalDelete = app.deps.host.deleteFile.bind(app.deps.host);
    app.deps.host.deleteFile = async (rel: string) => {
      if (rel.includes(".homestead-validate-")) {
        throw new Error("EACCES: permission denied");
      }
      return originalDelete(rel);
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/compose/validate`,
      headers: { cookie },
      payload: { content: "services:\n  web:\n    depends_on: [db]\n" },
    });

    // Must report the validation error, not the cleanup error.
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
    expect(res.json().message).toContain("db");

    // Prove it still works when valid.
    app.deps.host.composeResults.set("config --format json", {
      exitCode: 0,
      stdout: VALID,
      stderr: "",
    });
    const valid = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/compose/validate`,
      headers: { cookie },
      payload: { content: "services:\n  web:\n    image: nginx\n" },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().valid).toBe(true);

    await app.close();
  });
});
