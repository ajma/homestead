import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/**
 * A temp directory that removes itself when the current test finishes.
 *
 * Bare `mkdtemp` left thousands of `/tmp/hs-*` directories behind on the
 * development machine; several of them held compose files for stacks the suite
 * had actually started, which made those stacks unreachable for teardown.
 *
 * Only usable from a test or a `beforeEach` — `onTestFinished` needs a test to
 * attach to. `beforeAll` fixtures must clean up in their own `afterAll`.
 */
export async function tempDir(prefix = "hs-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
