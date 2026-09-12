import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMountPreflight } from "@server/host/preflight";
import Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

// A native ESM module namespace is not configurable, so `vi.spyOn(fsPromises, ...)`
// cannot override `writeFile` in place (Vitest's own error points here: "Module
// namespace is not configurable in ESM"). `vi.mock` with `importOriginal` sidesteps
// that by replacing the whole binding every other test in this file imports — wrapped
// in a real `vi.fn()` whose default implementation IS the real `writeFile`, so nothing
// here behaves differently unless a test explicitly queues a one-off override below.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

async function dockerAvailable(): Promise<boolean> {
  try {
    await new Docker({ socketPath: "/var/run/docker.sock" }).ping();
    return true;
  } catch {
    return false;
  }
}

const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)("runMountPreflight", () => {
  it("passes when the compose root is visible to the daemon at the same path", async () => {
    const root = await mkdtemp(join(tmpdir(), "hs-preflight-"));
    try {
      const result = await runMountPreflight({
        composeRoot: root,
        dockerSocket: "/var/run/docker.sock",
      });
      expect(result).toEqual({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  // NOTE ON COVERAGE: the branch this whole check exists for — the compose root being
  // writable here but resolving to a different directory on the host — cannot be
  // exercised from a test process that IS the host. It is reachable only when Homestead
  // runs containerised with a mismatched bind mount. The tests below cover the two
  // failure branches that ARE reachable. Do not read green tests as proof that the
  // path-mismatch detection works; that is verified by deploying.
  it("fails when the compose root cannot be written to at all", async () => {
    const result = await runMountPreflight({
      composeRoot: "/definitely/not/mounted/anywhere",
      dockerSocket: "/var/run/docker.sock",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/marker/i);
  }, 60_000);

  it("removes the marker directory even when writing the marker fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "hs-preflight-leak-"));
    const markerDir = join(root, ".homestead-preflight");
    try {
      // Pre-create it read-only: mkdir(recursive) succeeds, writeFile fails.
      await mkdir(markerDir);
      await chmod(markerDir, 0o500);

      const result = await runMountPreflight({
        composeRoot: root,
        dockerSocket: "/var/run/docker.sock",
      });

      expect(result.ok).toBe(false);
      await expect(readdir(root)).resolves.not.toContain(".homestead-preflight");
    } finally {
      await chmod(markerDir, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("retries the marker write once when it races a concurrent run's cleanup rmdir", async () => {
    // `markerDir` is shared by every concurrent run — a different run's own cleanup
    // `rmdir` (below, in `finally`) can land in the microseconds between this run's own
    // `mkdir` returning and its `writeFile` landing, deleting the directory this run just
    // saw exist and producing exactly the ENOENT `writeFile` throws when its parent is
    // gone. Reproduced deterministically here (real concurrent timing is not
    // guaranteed to trip it on every run) by making the first `writeFile` throw that
    // exact error once; the fix retries the same mkdir+writeFile pair, so this should
    // still succeed rather than reporting a false "cannot write a marker".
    const root = await mkdtemp(join(tmpdir(), "hs-preflight-write-race-"));
    try {
      const mockedWriteFile = vi.mocked(writeFile);
      mockedWriteFile.mockClear();
      mockedWriteFile.mockImplementationOnce(async () => {
        const err = new Error(
          "ENOENT: no such file or directory, open '...'",
        ) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      });

      const result = await runMountPreflight({
        composeRoot: root,
        dockerSocket: "/var/run/docker.sock",
      });

      expect(result).toEqual({ ok: true });
      // The one-off failure plus the retry that actually wrote it — proves a retry
      // happened at all, not just that the run eventually succeeded some other way.
      expect(mockedWriteFile).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("lets two concurrent runs against a healthy mount both succeed", async () => {
    // Both runs share the same `.homestead-preflight` directory. The first to finish
    // must remove only its own marker file — removing the whole directory would delete
    // the second run's marker before it has been read, failing a perfectly good mount.
    // This is a real end-to-end race between two container runs: it is a genuine
    // regression test, but its timing is not guaranteed to trip the bug on every run —
    // see the deterministic test below for that guarantee.
    const root = await mkdtemp(join(tmpdir(), "hs-preflight-concurrent-"));
    try {
      const [a, b] = await Promise.all([
        runMountPreflight({ composeRoot: root, dockerSocket: "/var/run/docker.sock" }),
        runMountPreflight({ composeRoot: root, dockerSocket: "/var/run/docker.sock" }),
      ]);
      expect(a).toEqual({ ok: true });
      expect(b).toEqual({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not delete a concurrent run's marker file that is not its own", async () => {
    // Deterministic version of the race above: plant a foreign marker file in the shared
    // `.homestead-preflight` directory before running, standing in for a concurrent run
    // that has not finished yet. A cleanup that removes the whole directory (the bug)
    // deletes it; a cleanup scoped to this run's own marker leaves it untouched.
    const root = await mkdtemp(join(tmpdir(), "hs-preflight-foreign-"));
    const markerDir = join(root, ".homestead-preflight");
    const foreignMarker = join(markerDir, "some-other-run.marker");
    try {
      await mkdir(markerDir, { recursive: true });
      await writeFile(foreignMarker, "someone else's token", "utf8");

      const result = await runMountPreflight({
        composeRoot: root,
        dockerSocket: "/var/run/docker.sock",
      });

      expect(result).toEqual({ ok: true });
      await expect(readFile(foreignMarker, "utf8")).resolves.toBe("someone else's token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("returns a failure rather than throwing when the Docker socket is unreachable", async () => {
    const root = await mkdtemp(join(tmpdir(), "hs-preflight-sock-"));
    try {
      const result = await runMountPreflight({
        composeRoot: root,
        dockerSocket: "/var/run/definitely-not-a-socket.sock",
      });
      expect(result.ok).toBe(false);
      await expect(readdir(root)).resolves.toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
