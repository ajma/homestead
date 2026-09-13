import { isAbsolute, relative } from "node:path";
import type { Host } from "../host/types.js";

/** Set by the Docker runtime to the container's own (short) id, unless a compose file or
 * `docker run --hostname` overrides it — neither of which Homestead's own compose stack
 * does. Reading it here, once, rather than threading `process.env` through every call
 * site, keeps the one non-deterministic input to detection in one place. */
function containerHostname(): string | undefined {
  return process.env.HOSTNAME;
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
 * entirely, at the cost of only ever needing to get the DETECTION logic right once.
 *
 * **How**: `HOSTNAME` inside a container is the container's own (short) id — read via
 * `containerHostname()`. Looking that id up in `host.listContainers()` (the same call
 * `routes/apps.ts` already makes for status) gives the container's labels, including
 * `com.docker.compose.project.working_dir` — the absolute host directory `docker compose`
 * was invoked from for THIS container. That directory, made relative to `composeRoot`,
 * is the directory Homestead's own adoption scan would discover it under, if any.
 *
 * **The failure mode, stated plainly**: run outside a container — `pnpm dev`, a bare
 * `node dist/server/index.js` — and `HOSTNAME` is either unset or some other value
 * (a shell's, or the bare host's) that will not be found in `listContainers()`'s result
 * (itself empty or irrelevant outside a real Docker host). This function returns `null`
 * for every one of those cases: it never guesses, and callers must treat `null` as
 * "cannot tell", not as "definitely not self". `adoption.ts`'s `scanForApps`/adopt path is
 * the only caller — see its own doc for the explicit-override path this leaves open for
 * a detection that ever comes out wrong.
 */
export async function detectSelfDirectory(deps: {
  host: Host;
  composeRoot: string;
}): Promise<string | null> {
  const hostname = containerHostname();
  if (!hostname) return null;

  const containers = await deps.host.listContainers();
  // `HOSTNAME` is Docker's short id; `listContainers()` reports dockerode's full id — a
  // prefix match, not equality, the same relationship `docker ps`/`docker inspect` treat
  // as identifying the same container everywhere else in this codebase.
  const self = containers.find((c) => c.id.startsWith(hostname));
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
