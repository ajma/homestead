import { access, chmod, constants } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { dockerChecks } from "./docker/preflight.js";
import {
  dataDirChecks,
  isNetworkFilesystem,
  portCheck,
  runChecks,
} from "./preflight.js";
import { tempDir } from "./test-support/tmp.js";

const MOUNTS = [
  "/dev/sda1 / ext4 rw,relatime 0 0",
  "nas:/export/data /mnt/nas nfs4 rw 0 0",
  "//server/share /mnt/smb cifs rw 0 0",
  "/dev/sdb1 /volume2 btrfs rw 0 0",
].join("\n");

describe("isNetworkFilesystem", () => {
  it("flags an NFS mount", () => {
    expect(isNetworkFilesystem("/mnt/nas/homestead", MOUNTS)).toBe(true);
  });

  it("flags a CIFS mount", () => {
    expect(isNetworkFilesystem("/mnt/smb/homestead", MOUNTS)).toBe(true);
  });

  it("accepts local btrfs", () => {
    expect(isNetworkFilesystem("/volume2/docker/.homestead", MOUNTS)).toBe(
      false,
    );
  });

  it("picks the longest matching mount point, not the first", () => {
    expect(isNetworkFilesystem("/volume2", MOUNTS)).toBe(false);
    expect(isNetworkFilesystem("/mnt/nas", MOUNTS)).toBe(true);
  });

  it("handles octal escapes in mount paths (spaces as \\040)", () => {
    const mountsWithEscapes = [
      "/dev/sda1 / ext4 rw,relatime 0 0",
      "nas:/export /mnt/nas\\040share nfs4 rw 0 0",
    ].join("\n");
    expect(
      isNetworkFilesystem("/mnt/nas share/homestead", mountsWithEscapes),
    ).toBe(true);
  });
});

describe("runChecks", () => {
  it("reports a writable data dir as ok", async () => {
    const dir = await tempDir("hs-pre-");
    const config = loadConfig({
      HOMESTEAD_DATA: dir,
      HOMESTEAD_PROJECTS: dir,
    });
    const results = await runChecks(dataDirChecks(config));
    expect(results.find((r) => r.id === "data_dir_writable")?.ok).toBe(true);
  });

  it("reports an unwritable data dir as a failure", async () => {
    // Was /proc/nope; the check now creates the directory, and mkdir under
    // /proc blocks indefinitely on some kernels instead of returning EACCES.
    // An existing directory with the write bit cleared covers the same case.
    const dir = await tempDir("hs-pre-");
    await chmod(dir, 0o500);
    try {
      const config = loadConfig({
        HOMESTEAD_DATA: dir,
        HOMESTEAD_PROJECTS: "/tmp",
      });
      const results = await runChecks(dataDirChecks(config));
      const check = results.find((r) => r.id === "data_dir_writable");
      expect(check?.ok).toBe(false);
      expect(check?.severity).toBe("warning");
    } finally {
      await chmod(dir, 0o700);
    }
  });

  // I4: the mkdir used to run in index.ts before the checks, so an unwritable
  // parent produced a raw EACCES stack and no preflight output at all. It is
  // now part of the check, and both flavours of failure report identically.
  it("creates a missing data dir rather than failing the check", async () => {
    const parent = await tempDir("hs-pre-");
    const dir = join(parent, "nested", "homestead");
    const config = loadConfig({
      HOMESTEAD_DATA: dir,
      HOMESTEAD_PROJECTS: parent,
    });
    const results = await runChecks(dataDirChecks(config));
    expect(results.find((r) => r.id === "data_dir_writable")?.ok).toBe(true);
    await expect(access(dir, constants.W_OK)).resolves.toBeUndefined();
  });

  it("reports an unwritable parent as a failure, not a crash", async () => {
    const parent = await tempDir("hs-pre-");
    await chmod(parent, 0o500);
    try {
      const config = loadConfig({
        HOMESTEAD_DATA: join(parent, "homestead"),
        HOMESTEAD_PROJECTS: parent,
      });
      const results = await runChecks(dataDirChecks(config));
      const check = results.find((r) => r.id === "data_dir_writable");
      expect(check?.ok).toBe(false);
      expect(check?.severity).toBe("warning");
      expect(check?.detail).toMatch(/EACCES|permission denied/i);
    } finally {
      await chmod(parent, 0o700);
    }
  });

  it("does not let one failing check abort the others", async () => {
    const results = await runChecks([
      {
        id: "boom",
        label: "Boom",
        severity: "warning",
        run: async () => {
          throw new Error("x");
        },
      },
      {
        id: "fine",
        label: "Fine",
        severity: "warning",
        run: async () => ({ ok: true, detail: "" }),
      },
    ]);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.id === "boom")?.ok).toBe(false);
    expect(results.find((r) => r.id === "fine")?.ok).toBe(true);
  });

  it("reports data loss when data dir is on a network filesystem", async () => {
    const dir = await tempDir("hs-pre-");
    const config = loadConfig({
      HOMESTEAD_DATA: dir,
      HOMESTEAD_PROJECTS: dir,
    });
    const mounts = [
      "/dev/sda1 / ext4 rw,relatime 0 0",
      `nas:/export ${dir} nfs4 rw 0 0`,
    ].join("\n");
    const results = await runChecks(dataDirChecks(config, async () => mounts));
    const check = results.find((r) => r.id === "data_dir_local_fs");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/data loss/i);
  });
});

describe("portCheck", () => {
  it("passes when the port is free", async () => {
    const r = await portCheck(7420, async () => true).run();
    expect(r.ok).toBe(true);
  });

  it("names the port when it is taken", async () => {
    // The raw EADDRINUSE that follows does not say which port, and on a NAS
    // the operator is reading a log, not a stack trace.
    const r = await portCheck(7420, async () => false).run();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("7420");
  });

  it("becomes a failed check rather than a crash when the probe throws", async () => {
    const check = portCheck(7420, async () => {
      throw new Error("boom");
    });
    const [result] = await runChecks([check]);
    expect(result?.ok).toBe(false);
  });
});

describe("severity", () => {
  it("marks data_dir_local_fs as danger in the actual checks", () => {
    const config = { dataDir: "/data", projectsDir: "/stacks" } as Config;
    const check = dataDirChecks(config).find(
      (c) => c.id === "data_dir_local_fs",
    );
    expect(check?.severity).toBe("danger");
  });

  it("marks the network-filesystem failure as danger, not warning", async () => {
    // Every other failure produces visible errors. This one corrupts quietly,
    // so it is the only one whose severity differs.
    const [result] = await runChecks([
      {
        id: "data_dir_local_fs",
        label: "Data directory is on a local filesystem",
        severity: "danger" as const,
        run: async () => ({ ok: false, detail: "on nfs4" }),
      },
    ]);
    expect(result?.severity).toBe("danger");
  });

  it("keeps every other check at warning severity", () => {
    const config = { dataDir: "/data", projectsDir: "/stacks" } as Config;
    const others = [...dataDirChecks(config), ...dockerChecks()].filter(
      (c) => c.id !== "data_dir_local_fs",
    );
    expect(others.length).toBeGreaterThan(0);
    for (const c of others) {
      expect(c.severity, `${c.id} should be a warning`).toBe("warning");
    }
  });
});
