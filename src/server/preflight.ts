import { access, constants, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { PreflightResult, Severity } from "@shared/preflight.js";
import type { Config } from "./config.js";

const NETWORK_FSTYPES = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smbfs",
  "smb3",
  "fuse.sshfs",
  "afs",
  "9p",
]);

export type Check = {
  id: string;
  label: string;
  severity: Severity;
  run: () => Promise<{ ok: boolean; detail: string }>;
};

function decodeOctalEscapes(str: string): string {
  return str.replace(/\\(\d{3})/g, (_, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function isNetworkFilesystem(path: string, mountTable: string): boolean {
  let best: { point: string; type: string } | undefined;
  for (const line of mountTable.split("\n")) {
    const [, pointRaw, type] = line.split(/\s+/);
    if (!pointRaw || !type) continue;
    const point = decodeOctalEscapes(pointRaw);
    if (path === point || path.startsWith(point === "/" ? "/" : `${point}/`)) {
      if (!best || point.length > best.point.length) best = { point, type };
    }
  }
  return best ? NETWORK_FSTYPES.has(best.type) : false;
}

export async function runChecks(checks: Check[]): Promise<PreflightResult[]> {
  return Promise.all(
    checks.map(async (c) => {
      try {
        const { ok, detail } = await c.run();
        return { id: c.id, label: c.label, severity: c.severity, ok, detail };
      } catch (err) {
        return {
          id: c.id,
          label: c.label,
          severity: c.severity,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

async function realReadMounts(): Promise<string> {
  return readFile("/proc/mounts", "utf8").catch(() => "");
}

export function dataDirChecks(
  config: Config,
  readMounts: () => Promise<string> = realReadMounts,
): Check[] {
  return [
    {
      id: "data_dir_writable",
      label: "Data directory is writable",
      severity: "warning",
      run: async () => {
        // Creating the directory is part of the check rather than a separate
        // step before it: when the parent is unwritable the mkdir is what fails
        // first, and runChecks turns that into a clean blocking FAIL line
        // instead of an unhandled EACCES at startup.
        await mkdir(config.dataDir, { recursive: true });
        await access(config.dataDir, constants.W_OK);
        return { ok: true, detail: config.dataDir };
      },
    },
    {
      id: "data_dir_local_fs",
      label: "Data directory is on a local filesystem",
      severity: "danger",
      run: async () => {
        const mounts = await readMounts();
        if (!mounts)
          return { ok: true, detail: "mount table unavailable; skipped" };
        const networked = isNetworkFilesystem(config.dataDir, mounts);
        return {
          ok: !networked,
          detail: networked
            ? `${config.dataDir} is on a network filesystem; data loss is possible. Move $HOMESTEAD_DATA to local storage.`
            : config.dataDir,
        };
      },
    },
    {
      id: "projects_dir_readable",
      label: "Projects directory is readable",
      severity: "warning",
      run: async () => {
        await access(config.projectsDir, constants.R_OK);
        return { ok: true, detail: config.projectsDir };
      },
    },
  ];
}

async function realPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

export function portCheck(
  port: number,
  probe: (port: number) => Promise<boolean> = realPortFree,
): Check {
  return {
    id: "port_free",
    label: "Listen port is available",
    severity: "warning",
    run: async () => {
      const free = await probe(port);
      return {
        ok: free,
        // Startup fails on its own when the port is taken. The check exists to
        // name which port, because the raw EADDRINUSE does not.
        detail: free ? `port ${port}` : `port ${port} is already in use`,
      };
    },
  };
}
