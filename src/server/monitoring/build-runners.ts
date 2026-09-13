import { MonitorAccessStore } from "../cloudflare/monitor-access.js";
import type { SecretStore } from "../crypto/secrets.js";
import type { Db } from "../db/client.js";
import { createHttpRunners } from "./http-runner.js";
import type { ProbeRunner } from "./types.js";

/**
 * Builds the `http_internal`/`http_external` probe runners, wiring the external one to
 * 2D's `MonitorAccessStore` for its Access service-token credentials.
 *
 * This is its own function, pulled out of `index.ts`'s composition root, for
 * testability: `index.ts` is a top-level-await entry point with real side effects and
 * zero test coverage by design (see `startup.ts`'s doc comment for why), so this
 * function is what `build-runners.test.ts` can actually exercise.
 *
 * That is NOT what closes the Phase 1 gap, though. The defect was never inside
 * `createHttpRunners` — it was a call site that omitted the `accessCredentials`
 * argument, and that argument used to be optional, so the omission type-checked and
 * every `http_external` probe reported `degraded` forever. Moving the wiring to a
 * function with its own test does not stop a *different* call site (this one, or a
 * future one added in `index.ts` directly) from making the same omission — a passing
 * test here cannot see a missing call one file up, any more than the Phase 1 test
 * could. What actually closes the gap is `createHttpRunners` requiring
 * `accessCredentials` at the type level (`http-runner.ts`): omitting it is now a
 * compile error, not a silently-accepted default.
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
