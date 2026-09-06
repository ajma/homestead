import { access, chmod, constants } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { dataDirChecks, isNetworkFilesystem, runChecks } from "./preflight.js";
import { tempDir } from "./test-support/tmp.js";

const MOUNTS = [
  "/dev/sda1 / ext4 rw,relatime 0 0",
  "nas:/export/data /mnt/nas nfs4 rw 0 0",
  "//server/share /mnt/smb cifs rw 0 0",
  "/dev/sdb1 /volume2 btrfs rw 0 0",
].join("\n");

describe("isNetworkFilesystem", () => {
  it("flags an NFS mount", () => {
    expect(isNetworkFilesystem("/mnt/nas/homestacks", MOUNTS)).toBe(true);
  });

  it("flags a CIFS mount", () => {
    expect(isNetworkFilesystem("/mnt/smb/homestacks", MOUNTS)).toBe(true);
  });

  it("accepts local btrfs", () => {
    expect(isNetworkFilesystem("/volume2/docker/.homestacks", MOUNTS)).toBe(
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
      isNetworkFilesystem("/mnt/nas share/homestacks", mountsWithEscapes),
    ).toBe(true);
  });
});

describe("runChecks", () => {
  it("reports a writable data dir as ok", async () => {
    const dir = await tempDir("hs-pre-");
    const config = loadConfig({
      HOMESTACKS_DATA: dir,
      HOMESTACKS_PROJECTS: dir,
    });
    const results = await runChecks(dataDirChecks(config));
    expect(results.find((r) => r.id === "data_dir_writable")?.ok).toBe(true);
  });

  it("reports an unwritable data dir as a blocking failure", async () => {
    // Was /proc/nope; the check now creates the directory, and mkdir under
    // /proc blocks indefinitely on some kernels instead of returning EACCES.
    // An existing directory with the write bit cleared covers the same case.
    const dir = await tempDir("hs-pre-");
    await chmod(dir, 0o500);
    try {
      const config = loadConfig({
        HOMESTACKS_DATA: dir,
        HOMESTACKS_PROJECTS: "/tmp",
      });
      const results = await runChecks(dataDirChecks(config));
      const check = results.find((r) => r.id === "data_dir_writable");
      expect(check?.ok).toBe(false);
      expect(check?.blocking).toBe(true);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  // I4: the mkdir used to run in index.ts before the checks, so an unwritable
  // parent produced a raw EACCES stack and no preflight output at all. It is
  // now part of the check, and both flavours of failure report identically.
  it("creates a missing data dir rather than failing the check", async () => {
    const parent = await tempDir("hs-pre-");
    const dir = join(parent, "nested", "homestacks");
    const config = loadConfig({
      HOMESTACKS_DATA: dir,
      HOMESTACKS_PROJECTS: parent,
    });
    const results = await runChecks(dataDirChecks(config));
    expect(results.find((r) => r.id === "data_dir_writable")?.ok).toBe(true);
    await expect(access(dir, constants.W_OK)).resolves.toBeUndefined();
  });

  it("reports an unwritable parent as a blocking failure, not a crash", async () => {
    const parent = await tempDir("hs-pre-");
    await chmod(parent, 0o500);
    try {
      const config = loadConfig({
        HOMESTACKS_DATA: join(parent, "homestacks"),
        HOMESTACKS_PROJECTS: parent,
      });
      const results = await runChecks(dataDirChecks(config));
      const check = results.find((r) => r.id === "data_dir_writable");
      expect(check?.ok).toBe(false);
      expect(check?.blocking).toBe(true);
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
        blocking: false,
        run: async () => {
          throw new Error("x");
        },
      },
      {
        id: "fine",
        label: "Fine",
        blocking: false,
        run: async () => ({ ok: true, detail: "" }),
      },
    ]);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.id === "boom")?.ok).toBe(false);
    expect(results.find((r) => r.id === "fine")?.ok).toBe(true);
  });
});
