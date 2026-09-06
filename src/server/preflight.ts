import { access, constants, readFile } from "node:fs/promises";
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

export type CheckResult = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
};

export type Check = {
  id: string;
  label: string;
  blocking: boolean;
  run: () => Promise<Omit<CheckResult, "id" | "label" | "blocking">>;
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

export async function runChecks(checks: Check[]): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async (c) => {
      try {
        const { ok, detail } = await c.run();
        return { id: c.id, label: c.label, blocking: c.blocking, ok, detail };
      } catch (err) {
        return {
          id: c.id,
          label: c.label,
          blocking: c.blocking,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

export function dataDirChecks(config: Config): Check[] {
  return [
    {
      id: "data_dir_writable",
      label: "Data directory is writable",
      blocking: true,
      run: async () => {
        await access(config.dataDir, constants.W_OK);
        return { ok: true, detail: config.dataDir };
      },
    },
    {
      id: "data_dir_local_fs",
      label: "Data directory is on a local filesystem",
      blocking: true,
      run: async () => {
        const mounts = await readFile("/proc/mounts", "utf8").catch(() => "");
        if (!mounts)
          return { ok: true, detail: "mount table unavailable; skipped" };
        const networked = isNetworkFilesystem(config.dataDir, mounts);
        return {
          ok: !networked,
          detail: networked
            ? `${config.dataDir} is on a network filesystem; SQLite locking is unreliable there`
            : config.dataDir,
        };
      },
    },
    {
      id: "projects_dir_readable",
      label: "Projects directory is readable",
      blocking: false,
      run: async () => {
        await access(config.projectsDir, constants.R_OK);
        return { ok: true, detail: config.projectsDir };
      },
    },
  ];
}
