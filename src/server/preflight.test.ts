import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { dataDirChecks, isNetworkFilesystem, runChecks } from "./preflight.js";

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
    const dir = await mkdtemp(join(tmpdir(), "hs-pre-"));
    const config = loadConfig({
      HOMESTACKS_DATA: dir,
      HOMESTACKS_PROJECTS: dir,
    });
    const results = await runChecks(dataDirChecks(config));
    expect(results.find((r) => r.id === "data_dir_writable")?.ok).toBe(true);
  });

  it("reports an unwritable data dir as a blocking failure", async () => {
    const config = loadConfig({
      HOMESTACKS_DATA: "/proc/nope",
      HOMESTACKS_PROJECTS: "/tmp",
    });
    const results = await runChecks(dataDirChecks(config));
    const check = results.find((r) => r.id === "data_dir_writable");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
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
