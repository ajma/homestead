import { buildTestApp, createViewer, signUpAdmin } from "@server/test-helpers";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

describe("GET /api/setup/state", () => {
  it("reports no completed steps and a null completedAt on a fresh install", async () => {
    // Unauthenticated on purpose: nobody can be signed in yet, so the wizard still needs
    // to render its own first step from this response.
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/setup/state" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ completedSteps: [], completedAt: null });
  });

  it("reports the admin step complete once any user exists, however they were created", async () => {
    // Login.tsx has created the first admin since Phase 1A. Someone who set up that way and
    // then opens the wizard must not be told to do it again.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({ method: "GET", url: "/api/setup/state", headers: { cookie } });
    expect(res.json().completedSteps).toContain("admin");
  });

  it("locks down once an admin exists", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "GET",
      url: "/api/setup/state",
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("degrades a corrupt completed_steps value to no completed steps rather than throwing", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    await app.inject({
      method: "POST",
      url: "/api/setup/state/host/complete",
      headers: { cookie },
    });

    // A hand-edited or otherwise corrupt value, bypassing the app entirely.
    await app.deps.db.run(sql`update setup_state set completed_steps = 'not-json' where id = 1`);

    const res = await app.inject({ method: "GET", url: "/api/setup/state", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // "host" is gone with the corruption, but "admin" survives because it is derived, not
    // read from the corrupt column at all.
    expect(res.json().completedSteps).toEqual(["admin"]);
  });
});

describe("POST /api/setup/state/:step/complete", () => {
  it("records a completed step", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/state/host/complete",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().completedSteps).toContain("host");
  });

  it("survives a restart: a fresh query after the write still sees it", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    await app.inject({
      method: "POST",
      url: "/api/setup/state/import/complete",
      headers: { cookie },
    });

    // A separate request, not the response body of the write above — this must come from
    // the table, not from anything held in memory across the two calls.
    const res = await app.inject({ method: "GET", url: "/api/setup/state", headers: { cookie } });
    expect(res.json().completedSteps).toContain("import");
  });

  it("is idempotent: completing the same step twice does not duplicate it", async () => {
    // Asserts on the STORED row, not just the API response — the response alone can look
    // idempotent even if the underlying array is quietly accumulating duplicates, since
    // reads collapse the derived `admin` step through a Set regardless of what got written.
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    await app.inject({
      method: "POST",
      url: "/api/setup/state/users/complete",
      headers: { cookie },
    });
    await app.inject({
      method: "POST",
      url: "/api/setup/state/users/complete",
      headers: { cookie },
    });

    const { setupState } = await import("../db/schema.js");
    const [row] = await app.deps.db.select().from(setupState).where(eq(setupState.id, 1));
    const stored = row?.completedSteps as string[];
    expect(stored.filter((step) => step === "users")).toHaveLength(1);
  });

  it("rejects an unknown step name instead of storing it", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/state/bogus/complete",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_step");

    const state = (
      await app.inject({ method: "GET", url: "/api/setup/state", headers: { cookie } })
    ).json();
    expect(state.completedSteps).not.toContain("bogus");
  });

  it("is admin-only", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/state/host/complete",
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/setup/finish", () => {
  it("sets completedAt", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const res = await app.inject({ method: "POST", url: "/api/setup/finish", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().completedAt).toEqual(expect.any(Number));
  });

  it("does not move completedAt on a second call", async () => {
    // finish is one-way: the wizard uses completedAt to refuse re-entry, so a second call
    // moving it would make a completed setup look freshly re-completed. Fake only Date so
    // a real clock tick between the two calls can never hide a bug here.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const app = await buildTestApp();
      const { cookie } = await signUpAdmin(app);
      const first = (
        await app.inject({ method: "POST", url: "/api/setup/finish", headers: { cookie } })
      ).json();
      vi.setSystemTime(Date.now() + 60_000);
      const second = (
        await app.inject({ method: "POST", url: "/api/setup/finish", headers: { cookie } })
      ).json();
      expect(second.completedAt).toBe(first.completedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is admin-only", async () => {
    const app = await buildTestApp();
    const { cookie } = await signUpAdmin(app);
    const viewer = await createViewer(app, cookie);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/finish",
      headers: { cookie: viewer.cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
