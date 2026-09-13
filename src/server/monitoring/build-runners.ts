import { MonitorAccessStore } from "../cloudflare/monitor-access.js";
import type { SecretStore } from "../crypto/secrets.js";
import type { Db } from "../db/client.js";
import { createHttpRunners } from "./http-runner.js";
import type { ProbeRunner } from "./types.js";

/**
 * Builds the `http_internal`/`http_external` probe runners, wiring the external one to
 * 2D's `MonitorAccessStore` for its Access service-token credentials.
 *
 * This is its own function, pulled out of `index.ts`'s composition root, for one
 * reason: `index.ts` is a top-level-await entry point with real side effects and zero
 * test coverage by design (see `startup.ts`'s doc comment for why). `createHttpRunners`
 * has accepted an `accessCredentials` callback since Phase 1 — nothing calling it with
 * one is exactly how every `http_external` probe reported `degraded` forever, and a
 * unit test of the runner itself cannot see a missing call site one file up. Pulling
 * the wiring into a function with its own test closes that gap: this IS the seam where
 * the defect lived, so this is what a test needs to hold onto.
 *
 * The callback reads `monitorStore.getCredentials()` fresh on every invocation — never
 * memoised — so a rotation (`rotateMonitorSecret`) takes effect on the very next probe
 * run rather than requiring a process restart.
 */
export function buildHttpRunners(deps: { fetch: typeof fetch; db: Db; secrets: SecretStore }): {
  internal: ProbeRunner;
  external: ProbeRunner;
} {
  const monitorStore = new MonitorAccessStore(deps.db, deps.secrets);
  return createHttpRunners({
    fetch: deps.fetch,
    accessCredentials: () => monitorStore.getCredentials(),
  });
}
