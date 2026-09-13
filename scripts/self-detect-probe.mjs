// Manual verification helper for scripts/verify-self-detect.sh — not part of the
// production build, and nothing else imports it. See that script's own header for why
// it exists and how it's run.
//
// Imports the REAL `detectSelfDirectory` from `self-detect.ts`, unmodified — this is the
// exact function `routes/apps.ts` calls in production, not a reimplementation. It does
// NOT import `host/local-host.ts`'s `LocalHost`: that file's constructor uses a
// TypeScript parameter property, syntax Node's `--experimental-strip-types` cannot erase
// (it needs `--experimental-transform-types`, which in turn cannot resolve this
// project's `./foo.js`-importing-`./foo.ts` layout — tried both, see the fix-wave
// report). The handful of lines below are the same shape as `LocalHost#listContainers`,
// built directly on `dockerode` — the real library, not a fake — so the only thing NOT
// exercised against the real daemon here is the one class method this script doesn't
// need for detection.
import Docker from "dockerode";
import { detectSelfDirectory } from "../src/server/apps/self-detect.ts";

const composeRoot = process.argv[2];
const dockerSocket = process.argv[3] ?? "/var/run/docker.sock";
if (!composeRoot) {
  console.error("usage: self-detect-probe.mjs <composeRoot> [dockerSocket]");
  process.exit(2);
}

const docker = new Docker({ socketPath: dockerSocket });

/** @type {import("../src/server/host/types.ts").Host} */
const host = {
  async listContainers() {
    const raw = await docker.listContainers({ all: true });
    return raw.map((c) => ({
      id: c.Id,
      names: (c.Names ?? []).map((n) => n.replace(/^\//, "")),
      image: c.Image,
      state: c.State,
      status: c.Status,
      project: c.Labels?.["com.docker.compose.project"] ?? null,
      service: c.Labels?.["com.docker.compose.service"] ?? null,
      labels: c.Labels ?? {},
    }));
  },
};

const result = await detectSelfDirectory({ host, composeRoot });
console.log(`SELF_DIRECTORY=${result === null ? "null" : result}`);
