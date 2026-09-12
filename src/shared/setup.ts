/**
 * Step 2 of onboarding proves the Docker socket works by showing the daemon's own
 * `docker version` response verbatim, and runs the mount round-trip preflight so a wrong
 * bind mount is caught here — loudly, on screen — rather than surfacing later as a stack
 * that silently starts with empty volumes.
 */
export type HostCheck = {
  composeRoot: string;
  docker:
    | { ok: true; version: string; apiVersion: string; os: string; arch: string }
    | { ok: false; message: string };
  preflight: { ok: true } | { ok: false; reason: string };
};
