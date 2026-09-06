import type { Check } from "../preflight.js";
import { type Runner, runDocker } from "./run.js";

export function dockerChecks(run: Runner = runDocker): Check[] {
  return [
    {
      id: "docker_reachable",
      label: "Docker daemon is reachable",
      blocking: true,
      run: async () => {
        const { stdout, stderr, code } = await run([
          "version",
          "--format",
          "{{.Server.Version}}",
        ]);
        if (code !== 0)
          return {
            ok: false,
            detail: stderr.trim() || `docker exited ${code}`,
          };
        return { ok: true, detail: `Engine ${stdout.trim()}` };
      },
    },
    {
      id: "compose_v2",
      label: "Docker Compose v2 is available",
      blocking: true,
      run: async () => {
        const { stdout, stderr, code } = await run([
          "compose",
          "version",
          "--short",
        ]);
        if (code !== 0)
          return {
            ok: false,
            detail: stderr.trim() || "docker compose not available",
          };
        const version = stdout.trim();
        const major = Number.parseInt(
          version.replace(/^v/, "").split(".")[0] ?? "",
          10,
        );
        if (!Number.isFinite(major) || major < 2) {
          return {
            ok: false,
            detail: `found "${version}", Homestead requires Compose v2 or newer`,
          };
        }
        return { ok: true, detail: `Compose ${version}` };
      },
    },
  ];
}
