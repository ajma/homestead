import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { Host } from "../host/types.js";

const SELF_MOUNTINFO_PATH = "/proc/self/mountinfo";

/**
 * Docker always bind-mounts a container's `/etc/hostname`, `/etc/hosts` and
 * `/etc/resolv.conf` from `<data-root>/containers/<full-id>/...` on the host side — that
 * bind mount is how the container gets those files at all, and creating it does not
 * depend on network mode. Matching the path SUFFIX (`containers/<64-hex-id>/...`) rather
 * than anchoring on `/var/lib/docker` also survives a customised `dockerd --data-root`.
 *
 * This is the id `detectSelfDirectory` below actually uses. See its own doc comment for
 * why `$HOSTNAME` — the previous approach — cannot work for Homestead's own deployment.
 */
const CONTAINER_ID_MOUNT_PATTERN = /\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf)$/;

/**
 * Pure string processing, factored out of `detectSelfDirectory` so it can be exercised
 * directly against mountinfo text captured from a real daemon rather than only through a
 * `Host` fake — see `self-detect.test.ts`'s own note on where that fixture came from.
 *
 * `/proc/self/mountinfo`'s format (`man 5 proc`) is space-separated fields, an optional
 * run of tagged fields, then ` - ` and the filesystem type/source/options. Field 4 (0
 * indexed 3), the "root", is the path of this mount within its underlying filesystem or
 * bind source — this is the field carrying `.../containers/<id>/hostname`, not the mount
 * point (field 5, `/etc/hostname`) and not the "mount source" after the ` - ` separator.
 * None of the three fields before it can contain a space, so a plain split is exact.
 */
export function extractSelfContainerId(mountinfoText: string): string | null {
  for (const line of mountinfoText.split("\n")) {
    const root = line.split(" ")[3];
    if (!root) continue;
    const match = CONTAINER_ID_MOUNT_PATTERN.exec(root);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** `null` covers every reason this can fail to tell us anything: not Linux, not
 * containerised, `/proc` unavailable — all "cannot tell", same as the rest of this
 * file's contract. */
async function readSelfMountinfo(): Promise<string | null> {
  try {
    return await readFile(SELF_MOUNTINFO_PATH, "utf8");
  } catch {
    return null;
  }
}

/** The label `docker compose` stamps on every container it starts, holding the absolute
 * host path `compose` was invoked from — the same path Homestead's own `composeRoot`
 * config must agree with (`docs/.../homestead-design.md`'s "path-identity constraint"),
 * which is what makes comparing the two meaningful at all. */
const COMPOSE_WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";

/**
 * Homestead recognising itself: the two honest options, and why this is detection.
 *
 * **Detection is chosen over an admin toggle** because the admin cannot get it wrong —
 * and getting it wrong is asymmetric and bad either way: a FALSE POSITIVE marks the
 * wrong app, and 2B's guards (`routes/jobs.ts`, `routes/apps.ts`) then refuse every
 * lifecycle action and delete on it — visible and annoying, but immediately obvious and
 * reversible. A FALSE NEGATIVE means `resolveAccessSettings` (`auth/access-settings.ts`)
 * silently never resolves from the database — invisible, with no error anywhere to
 * notice. Detection this cheap (one already-mounted Docker socket read, already a
 * dependency — no new one added) removes the chance of a false positive from admin error
 * entirely, at the cost of only ever needing to get the DETECTION logic right once. See
 * `routes/apps.ts`'s `PATCH /api/apps/:id {systemKind}` for the explicit override this
 * leaves open when detection is wrong, and `OverviewTab.tsx` for where an admin sets it.
 *
 * **How**: this container's own id, read via `extractSelfContainerId` from
 * `/proc/self/mountinfo` (see that function's own doc for the mechanism). Looking that id
 * up in `host.listContainers()` (the same call `routes/apps.ts` already makes for status)
 * gives the container's labels, including `com.docker.compose.project.working_dir` — the
 * absolute host directory `docker compose` was invoked from for THIS container. That
 * directory, made relative to `composeRoot`, is the directory Homestead's own adoption
 * scan would discover it under, if any.
 *
 * **Why not `$HOSTNAME`, which this used before Phase 2F's whole-branch review (F1)**:
 * `$HOSTNAME` inside a container is normally the container's own short id — until
 * `network_mode: host` is set, which shares the host's UTS namespace and makes it the
 * HOST's hostname instead. `compose.example.yaml` sets exactly that (§3 of
 * `docs/deployment.md`, for a reason unrelated to this), which is Homestead's *own*
 * shipped deployment, not a hypothetical: measured on Docker 29.8.0, `--network host`
 * gives the container `HOSTNAME=<the NAS's hostname>`, never a value
 * `listContainers()`'s ids would ever start with. Detection then returned `null` forever,
 * silently — see the review for the full failure scenario. The mountinfo bind mount this
 * file reads instead comes from the mount table, not the UTS namespace, so it is
 * unaffected by network mode; measured against a real daemon under `network_mode: host`,
 * matching `compose.example.yaml` exactly, in `scripts/verify-self-detect.sh`.
 *
 * **The failure mode, stated plainly**: run outside a container — `pnpm dev`, a bare
 * `node dist/server/index.js` — and `/proc/self/mountinfo` either does not exist (most
 * non-Linux dev machines) or exists but contains no `containers/<id>/...` bind mount at
 * all. This function returns `null` for every one of those cases, and for a Docker socket
 * it cannot reach: it never guesses, and callers must treat `null` as "cannot tell", not
 * as "definitely not self". `adoption.ts`'s `scanForApps`/adopt path is the only caller.
 */
export async function detectSelfDirectory(deps: {
  host: Host;
  composeRoot: string;
  /** Overridable only for `self-detect.test.ts`, so it can feed mountinfo text captured
   * from a real daemon without needing a container to run in. Production callers never
   * pass this. */
  readMountinfo?: () => Promise<string | null>;
}): Promise<string | null> {
  const mountinfo = await (deps.readMountinfo ?? readSelfMountinfo)();
  if (mountinfo === null) return null;

  const containerId = extractSelfContainerId(mountinfo);
  if (containerId === null) return null;

  let containers: Awaited<ReturnType<Host["listContainers"]>>;
  try {
    containers = await deps.host.listContainers();
  } catch {
    // An unreachable Docker socket is "cannot tell", not a guess and not something the
    // caller should have to catch itself — `routes/apps.ts`'s adopt route used to 500
    // the whole request on exactly this (Phase 2F whole-branch review, F4).
    return null;
  }
  const self = containers.find((c) => c.id === containerId);
  if (!self) return null;

  const workingDir = self.labels[COMPOSE_WORKING_DIR_LABEL];
  if (!workingDir || !isAbsolute(workingDir)) return null;

  const rel = relative(deps.composeRoot, workingDir);
  // Empty means `workingDir === composeRoot` itself, which is not one of the
  // subdirectories `listAppDirectories` ever discovers as an app; a leading `..` or a
  // still-absolute result means `workingDir` sits outside `composeRoot` entirely (a
  // Docker Compose stack the admin manages some other way). Either way, this container's
  // own directory is not one Homestead's adoption scan could ever discover, so there is
  // nothing to mark.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;

  return rel;
}
