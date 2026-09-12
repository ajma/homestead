import { parseEnv, serialiseEnv, upsertEnv } from "@shared/env-file.js";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { normaliseProjectName } from "../apps/adoption.js";
import type { Step } from "../apps/step-sequence.js";
import { LOCAL_HOST_ID } from "../bootstrap.js";
import type { Db } from "../db/client.js";
import { retryOnBusy } from "../db/retry.js";
import { apps, probes } from "../db/schema.js";
import type { Host } from "../host/types.js";
import type { CloudflareClient } from "./client.js";
import { scaffoldCloudflared } from "./scaffold-cloudflared.js";
import type { TunnelStore } from "./tunnel-store.js";

/**
 * Homestead writes exactly one system app for its one remotely-managed tunnel — there is
 * no user-chosen directory or slug here, unlike an adopted or hand-created app, so these
 * are fixed rather than derived from anything a caller passes in.
 */
export const CLOUDFLARED_DIRECTORY = "cloudflared";
const CLOUDFLARED_COMPOSE_FILE = "compose.yaml";
const CLOUDFLARED_SLUG = "cloudflared";

/**
 * The name Homestead's one managed tunnel is created (or adopted — see `create-tunnel`
 * below) under. Fixed, not user-chosen, for the same reason the directory above is: §6
 * describes exactly one remotely-managed tunnel, so there is nothing for a caller to name.
 */
export const CLOUDFLARED_TUNNEL_NAME = "homestead";

/** `docker compose up -d` on a first run also pulls `cloudflare/cloudflared:latest`, so
 * this is sized like a pull rather than a plain `up` against a warm image cache. */
const COMPOSE_TIMEOUT_MS = 5 * 60_000;

/**
 * Carries what each step hands to the ones after it. Every field is optional because it
 * is unset until the step that produces it has actually run — a step reading its own
 * field is the normal case, but a step's `undo` reading a field that was NEVER set (because
 * an earlier step never completed) is exactly the silent-no-op hazard this sequence exists
 * to avoid. Every `undo` below checks for `undefined` before acting, and every `run` that
 * depends on an earlier field throws loudly if it is missing rather than passing
 * `undefined` on to Cloudflare or the database.
 */
export type ProvisionCtx = {
  tunnelId?: string;
  tunnelName?: string;
  /** Never logged, never put in a thrown error's message, and never written to `ctx` by
   * anything that would let it reach `StepJobRunner`'s transcript — see `create-tunnel`'s
   * and `fetch-token`'s comments below for how each step that touches it keeps that true. */
  token?: string;
  createdAt?: number;
  appId?: string;
};

export type ProvisionTunnelDeps = {
  db: Db;
  host: Host;
  client: CloudflareClient;
  tunnelStore: TunnelStore;
  /** Overridable only for tests that need a second, distinguishable name — production
   * code always passes `CLOUDFLARED_TUNNEL_NAME`. */
  tunnelName: string;
};

/**
 * Builds the five-step provision sequence (spec §6), for `runSteps`/`StepJobRunner` to
 * run. Pure with respect to Cloudflare and the database in the sense that matters here:
 * every side effect is reached through `deps`, so a test can substitute a fake
 * `CloudflareClient` and either `FakeHost` or a real `LocalHost` without this function
 * knowing which.
 *
 * **Where the "already provisioned" check lives:** deliberately NOT here. The caller
 * (the route) checks `TunnelStore.get()` before ever building this sequence or taking the
 * `StepJobRunner` lock — that is the common case (a tunnel is already fully recorded) and
 * it costs nothing: no lock, no job row, no Cloudflare round trip. `create-tunnel` below
 * still has its OWN idempotency on top of that, for a narrower case the route-level check
 * cannot see: a previous attempt that got as far as creating the tunnel in Cloudflare but
 * never recorded it — because it crashed, or because THIS step's own `undo` (delete the
 * tunnel) itself failed during that attempt's rollback (`runSteps` guarantees rollback
 * keeps going through a throwing `undo`, which means a failed delete does not stop the
 * job, it just leaves the tunnel behind with no local record of it). Splitting it this way
 * keeps each check answering one question: the route asks "do we already have a working
 * tunnel", `create-tunnel` asks "does Cloudflare already have one under this name".
 */
export function tunnelProvisionSteps(deps: ProvisionTunnelDeps): Array<Step<ProvisionCtx>> {
  const composePath = `${CLOUDFLARED_DIRECTORY}/${CLOUDFLARED_COMPOSE_FILE}`;
  const envPath = `${CLOUDFLARED_DIRECTORY}/.env`;

  return [
    {
      name: "create-tunnel",
      async run(ctx) {
        // Idempotent by adopting a live tunnel of the same name rather than by asking
        // Cloudflare to refuse a duplicate (it will not — tunnel names are not enforced
        // unique by this API). Safe under the plan's stated assumption that the account
        // is a clean slate with nothing built (2A's plan): a real risk of this approach
        // is adopting a stranger's unrelated tunnel that happens to share the name, which
        // a clean account rules out. `deletedAt === null` excludes a soft-deleted tunnel
        // of the same name, which must not be adopted — see `client.ts`'s `listTunnels`.
        const existing = await deps.client.listTunnels();
        const live = existing.find((t) => t.name === deps.tunnelName && t.deletedAt === null);
        if (live) {
          ctx.tunnelId = live.id;
          ctx.tunnelName = live.name;
          return;
        }
        const created = await deps.client.createTunnel(deps.tunnelName);
        ctx.tunnelId = created.id;
        ctx.tunnelName = created.name;
      },
      async undo(ctx) {
        // Unset only if `run` never completed — which never happens for a step actually
        // being undone (rule 1 in `step-sequence.ts`), but this makes that guarantee
        // load-bearing rather than assumed: without it, a refactor that ever DID undo the
        // failing step would call `deleteTunnel(undefined)` instead of silently skipping.
        if (ctx.tunnelId === undefined) return;
        await deps.client.deleteTunnel(ctx.tunnelId);
      },
    },
    {
      name: "fetch-token",
      async run(ctx) {
        if (ctx.tunnelId === undefined || ctx.tunnelName === undefined) {
          throw new Error("fetch-token ran before create-tunnel produced a tunnel id");
        }
        const token = await deps.client.tunnelToken(ctx.tunnelId);
        const createdAt = Math.floor(Date.now() / 1000);
        // `appId: null` — the app row does not exist yet (it is `register-app`, below,
        // that creates it). `TunnelRecord.appId` is nullable exactly for this window.
        await deps.tunnelStore.set(
          { tunnelId: ctx.tunnelId, name: ctx.tunnelName, appId: null, createdAt },
          token,
        );
        // Held on `ctx` only long enough for `write-files` to interpolate it into `.env`
        // and for `register-app` to re-persist the record with `appId` filled in. Nothing
        // downstream ever puts this into a thrown error's message or a log line — see the
        // type's own doc comment.
        ctx.token = token;
        ctx.createdAt = createdAt;
      },
      async undo() {
        // Clears unconditionally rather than checking `ctx.token` first: `set()` above
        // either fully committed (one transaction) or never ran, and `clear()` is safe to
        // call on an already-clear store (`tunnel-store.ts`'s own doc comment).
        await deps.tunnelStore.clear();
      },
    },
    {
      name: "write-files",
      async run(ctx) {
        if (ctx.token === undefined) {
          throw new Error("write-files ran before fetch-token produced a token");
        }
        const { composeFile, envFile } = scaffoldCloudflared();
        const envContent = serialiseEnv(upsertEnv(parseEnv(envFile), "TUNNEL_TOKEN", ctx.token));

        // Idempotent (`createAppDirectory`'s own doc comment): a retry after a later step
        // fails must not die on the directory already existing.
        await deps.host.createAppDirectory(CLOUDFLARED_DIRECTORY);
        await deps.host.writeTextFile(composePath, composeFile, null);
        try {
          await deps.host.writeTextFile(envPath, envContent, null);
        } catch (error) {
          // This step's own effect must be all-or-nothing, the same reasoning as
          // `register-app` below: a `write-files` that reports itself as FAILED (by
          // throwing) is never undone by `runSteps` (rule 1), so if the compose file
          // write already landed, nothing else will ever remove it unless this step
          // removes it itself before rethrowing.
          await deps.host.deleteFile(composePath).catch(() => {
            // Best effort — the original `.env` write error is what the caller needs to
            // see, not a secondary cleanup failure masking it.
          });
          throw error;
        }
      },
      async undo() {
        // `deleteFile` is idempotent (tolerates an already-missing target), so this is
        // safe to run even if `run` only got partway before the compensation above already
        // cleaned up. The directory itself is left behind, empty — `Host` has no
        // directory-removal primitive, and an empty stray directory is a far smaller
        // problem than a stray compose file with a real token in its `.env`.
        await deps.host.deleteFile(composePath);
        await deps.host.deleteFile(envPath);
      },
    },
    {
      name: "register-app",
      async run(ctx) {
        if (ctx.tunnelId === undefined || ctx.tunnelName === undefined || ctx.token === undefined) {
          throw new Error("register-app ran before earlier steps produced a tunnel and token");
        }
        const id = ulid();
        await retryOnBusy(() =>
          deps.db.transaction(async (tx) => {
            await tx.insert(apps).values({
              id,
              hostId: LOCAL_HOST_ID,
              slug: CLOUDFLARED_SLUG,
              displayName: "cloudflared",
              directory: CLOUDFLARED_DIRECTORY,
              composeFile: CLOUDFLARED_COMPOSE_FILE,
              projectName: normaliseProjectName(CLOUDFLARED_DIRECTORY),
              systemKind: "cloudflared",
            });
            await tx.insert(probes).values({ id: ulid(), appId: id, kind: "docker" });
          }),
        );
        // From here the row (and its probe, cascade-deleted with it) exists. Recorded on
        // `ctx` immediately — both so THIS run's own compensation below can find it, and
        // so `undo` can find it if a LATER step fails instead.
        ctx.appId = id;

        try {
          // Re-persists the tunnel record with `appId` filled in now that the app exists
          // — see the type doc on `TunnelRecord.appId` (task-1-2 report) and the UI's
          // need to link from the tunnel panel to this app (2C Task 4).
          await deps.tunnelStore.set(
            {
              tunnelId: ctx.tunnelId,
              name: ctx.tunnelName,
              appId: id,
              createdAt: ctx.createdAt ?? Math.floor(Date.now() / 1000),
            },
            ctx.token,
          );
        } catch (error) {
          // Same all-or-nothing requirement as `write-files`: this step reporting FAILED
          // must not be the reason an app row survives `runSteps`' rollback (rule 1 — the
          // failing step is never undone). Compensate inline rather than leaving an
          // inserted row for nobody to clean up.
          await deps.db.delete(apps).where(eq(apps.id, id));
          ctx.appId = undefined;
          throw error;
        }
      },
      async undo(ctx) {
        if (ctx.appId === undefined) return;
        // Cascades to the probe row (`probes.appId` is `onDelete: "cascade"`).
        await deps.db.delete(apps).where(eq(apps.id, ctx.appId));
      },
    },
    {
      name: "compose-up",
      async run() {
        const handle = deps.host.runCompose(
          { directory: CLOUDFLARED_DIRECTORY, composeFile: CLOUDFLARED_COMPOSE_FILE },
          ["up", "-d"],
          { timeoutMs: COMPOSE_TIMEOUT_MS },
        );
        const result = await handle.result;
        if (result.exitCode !== 0) {
          // Thrown, not swallowed: a failed `up` must not leave a half-registered system
          // app, and `runSteps` only rolls back on a thrown `run`.
          throw new Error(
            `docker compose up failed for ${CLOUDFLARED_DIRECTORY} (exit ${result.exitCode}): ` +
              (result.stderr || result.stdout || "no output").slice(-2000),
          );
        }
      },
      async undo() {
        const handle = deps.host.runCompose(
          { directory: CLOUDFLARED_DIRECTORY, composeFile: CLOUDFLARED_COMPOSE_FILE },
          ["down"],
          { timeoutMs: COMPOSE_TIMEOUT_MS },
        );
        const result = await handle.result;
        if (result.exitCode !== 0) {
          // A failed `down` is exactly what `undoFailures` exists to surface — see
          // `step-job-runner.ts`'s `buildOutput`. Throwing here, rather than swallowing a
          // non-zero exit, is what gets it there.
          throw new Error(
            `docker compose down failed for ${CLOUDFLARED_DIRECTORY} (exit ${result.exitCode}): ` +
              (result.stderr || result.stdout || "no output").slice(-2000),
          );
        }
      },
    },
  ];
}
