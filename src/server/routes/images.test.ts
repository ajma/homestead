import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

const CONFIG = JSON.stringify({ name: "jellyfin", services: { web: { image: "nginx:alpine" } } });

async function withApp() {
  const app = await buildTestApp();
  const { cookie } = await signUpAdmin(app);
  app.deps.host.files.set("jellyfin/compose.yaml", "services: {}\n");
  app.deps.host.composeResults.set("config --format json", {
    exitCode: 0,
    stdout: CONFIG,
    stderr: "",
  });
  app.deps.host.images.set("nginx:alpine", { id: "x", repoDigests: ["nginx@sha256:old"] });
  const adopted = await app.inject({
    method: "POST",
    url: "/api/apps/adopt",
    headers: { cookie },
    payload: { directories: ["jellyfin"] },
  });
  return { app, cookie, id: adopted.json().adopted[0].id as string };
}

describe("image update API", () => {
  it("is empty until a check has run", async () => {
    const { app, cookie, id } = await withApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/apps/${id}/images`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("reports an available update after a check", async () => {
    const { app, cookie, id } = await withApp();
    app.deps.registryDigests.set("nginx:alpine", "sha256:new");
    const res = await app.inject({
      method: "POST",
      url: `/api/apps/${id}/images/check`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({
      serviceName: "web",
      currentDigest: "sha256:old",
      latestDigest: "sha256:new",
      updateAvailable: true,
    });
    await app.close();
  });

  it("refuses a viewer", async () => {
    const { app, cookie, id } = await withApp();
    const viewer = await createViewer(app, cookie);
    for (const [method, url] of [
      ["GET", `/api/apps/${id}/images`],
      ["POST", `/api/apps/${id}/images/check`],
    ] as const) {
      expect(
        (await app.inject({ method, url, headers: { cookie: viewer.cookie } })).statusCode,
      ).toBe(403);
    }
    await app.close();
  });
});
