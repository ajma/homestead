import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findComposeFile, projectPath } from "../projects/store.js";
import { type Runner, runDocker } from "./run.js";
import { buildOverride } from "./translate.js";

export type ComposeContext = {
  projectsDir: string;
  projectsHostDir: string;
  dataDir: string;
  slug: string;
};

export type ContainerState = {
  service: string;
  name: string;
  state: string;
  health: string | null;
  exitCode: number;
};

/**
 * Validates compose verb for safety. Uses allow-list for `down` to prevent
 * volume removal and other destructive operations. Throws on unsafe arguments.
 */
export function validateComposeVerb(verb: string[]): void {
  if (verb[0] !== "down") return;

  // For down, only allow known-safe arguments
  const safeArgs = new Set(["--remove-orphans"]);

  for (let i = 1; i < verb.length; i++) {
    const arg = verb[i];
    if (!arg) continue;

    // Timeout flags take a value that must be a non-negative integer
    if (arg === "--timeout" || arg === "-t") {
      const value = verb[i + 1];
      if (value === undefined) {
        throw new Error(
          `refusing to run \`compose down ${arg}\`: missing timeout value`,
        );
      }
      // Reject if it starts with '-' (likely another flag)
      if (value.startsWith("-")) {
        throw new Error(
          `refusing to run \`compose down ${value}\`: ${
            value === "-v" || value === "--volumes"
              ? "volume removal is a separate action"
              : "unknown or unsafe flag for `down`"
          }`,
        );
      }
      // Validate it's a non-negative integer
      const num = Number(value);
      if (!Number.isInteger(num) || num < 0) {
        throw new Error(
          `refusing to run \`compose down ${arg} ${value}\`: timeout must be a non-negative integer`,
        );
      }
      i++; // Skip the validated timeout value
      continue;
    }

    // Check if it's in the safe list
    if (safeArgs.has(arg)) {
      continue;
    }

    // Reject everything else, with specific message for volume-related flags
    if (arg === "-v" || arg === "--volumes") {
      throw new Error(
        `refusing to run \`compose down ${arg}\`: volume removal is a separate action`,
      );
    }

    throw new Error(
      `refusing to run \`compose down ${arg}\`: unknown or unsafe flag for \`down\``,
    );
  }
}

export function composeArgs(
  ctx: ComposeContext,
  composeFile: string,
  overridePath: string | null,
  verb: string[],
): string[] {
  const dir = projectPath(ctx.projectsDir, ctx.slug);
  const args = ["compose", "-f", join(dir, composeFile)];
  if (overridePath) args.push("-f", overridePath);
  return [...args, ...verb];
}

/** Resolves the real compose filename — it may be compose.yaml — then delegates. */
async function argsFor(
  ctx: ComposeContext,
  overridePath: string | null,
  verb: string[],
): Promise<string[]> {
  const dir = projectPath(ctx.projectsDir, ctx.slug);
  const composeFile = (await findComposeFile(dir)) ?? "docker-compose.yml";
  return composeArgs(ctx, composeFile, overridePath, verb);
}

export async function composeConfig(
  ctx: ComposeContext,
  run: Runner = runDocker,
): Promise<unknown> {
  const args = await argsFor(ctx, null, ["config", "--format", "json"]);
  const { stdout, stderr, code } = await run(args);
  if (code !== 0)
    throw new Error(stderr.trim() || `docker compose config exited ${code}`);
  return JSON.parse(stdout);
}

/**
 * Regenerated before every invocation — the compose file may have changed
 * since the last one. Returns null when translation is inactive.
 */
export async function ensureOverride(
  ctx: ComposeContext,
  run: Runner = runDocker,
): Promise<string | null> {
  if (ctx.projectsDir === ctx.projectsHostDir) return null;
  const canonical = await composeConfig(ctx, run);
  const yaml = buildOverride(canonical, {
    projectsDir: ctx.projectsDir,
    projectsHostDir: ctx.projectsHostDir,
    slug: ctx.slug,
  });
  const path = join(ctx.dataDir, "run", `${ctx.slug}.override.yml`);
  if (yaml === null) {
    await rm(path, { force: true });
    return null;
  }
  await mkdir(join(ctx.dataDir, "run"), { recursive: true });
  await writeFile(path, yaml, "utf8");
  return path;
}

export async function composePs(
  ctx: ComposeContext,
  run: Runner = runDocker,
): Promise<ContainerState[]> {
  const args = await argsFor(ctx, null, ["ps", "--all", "--format", "json"]);
  const { stdout, code } = await run(args);
  if (code !== 0) return [];
  // Compose emits one JSON object per line, not a JSON array.
  // Parse defensively: skip malformed lines, return valid ones.
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  const containers: ContainerState[] = [];

  for (const line of lines) {
    try {
      const c = JSON.parse(line) as Record<string, unknown>;
      containers.push({
        service: String(c.Service ?? ""),
        name: String(c.Name ?? ""),
        state: String(c.State ?? "unknown"),
        health: c.Health ? String(c.Health) : null,
        exitCode: Number(c.ExitCode ?? 0),
      });
    } catch {}
  }

  return containers;
}

/** Streams merged stdout and stderr. Resolves with the exit code; does not throw on non-zero. */
export async function composeExec(
  ctx: ComposeContext,
  verb: string[],
  onOutput: (chunk: string) => void,
  run: Runner = runDocker,
): Promise<number> {
  validateComposeVerb(verb);
  const overridePath = await ensureOverride(ctx, run);
  const args = await argsFor(ctx, overridePath, verb);

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: projectPath(ctx.projectsDir, ctx.slug),
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
