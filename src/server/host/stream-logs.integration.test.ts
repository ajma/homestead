import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LocalHost } from "@server/host/local-host";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const hasDocker = await run("docker", ["version"])
  .then(() => true)
  .catch(() => false);

describe.skipIf(!hasDocker)("streamLogs against real Docker", () => {
  const name = `homestead-logtest-${Date.now()}`;
  afterAll(async () => {
    await run("docker", ["rm", "-f", name]).catch(() => {});
  });

  it("separates stdout from stderr on a non-TTY container without leaking header bytes", async () => {
    // The case FakeHost cannot reach: a real multiplexed stream, whose 8-byte headers
    // become control characters in the log pane if the demultiplexer is wrong. The
    // accented text is here because a multi-byte character split across two frames comes
    // back as replacement characters without a persistent decoder.
    await run("docker", [
      "run",
      "--name",
      name,
      "alpine:3",
      "sh",
      "-c",
      "echo 'out: café ✓'; echo 'err: problem' 1>&2; echo 'out: second'",
    ]);
    const host = new LocalHost("local", "/tmp", "/var/run/docker.sock");
    await host.init();

    const lines: Array<{ text: string; stream: string }> = [];
    for await (const line of host.streamLogs({
      containerId: name,
      follow: false,
      tail: 100,
    })) {
      lines.push(line);
    }
    const textOf = (stream: string) =>
      lines
        .filter((l) => l.stream === stream)
        .map((l) => l.text)
        .join("");

    expect(textOf("stdout")).toContain("out: café ✓");
    expect(textOf("stdout")).toContain("out: second");
    expect(textOf("stderr")).toContain("err: problem");
    // No header bytes and no mangled characters.
    const all = lines.map((l) => l.text).join("");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Testing for Docker header bytes
    expect(all).not.toMatch(/[\u0000-\u0008]/);
    expect(all).not.toContain("\uFFFD");
  });

  it("masks env values from a real inspect", async () => {
    const host = new LocalHost("local", "/tmp", "/var/run/docker.sock");
    await host.init();
    const inspected = await host.inspectContainer(name);
    expect(inspected.env.length).toBeGreaterThan(0);
    // PATH always exists and always has a value; none of it may appear.
    expect(JSON.stringify(inspected.env)).not.toContain("/usr/local/sbin");
    expect(inspected.env.every((e) => e.masked === "••••••••" || e.masked === "")).toBe(true);
  });

  it("closes the Docker socket when the signal is aborted on an idle container", async () => {
    // Without the signal, an abandoned log stream on an idle container with follow:true
    // holds the Docker socket open indefinitely. The loop consults `disconnected` only
    // when a chunk arrives, and on an idle container no chunk ever arrives. One socket,
    // one ChunkQueue, and one request object per closed tab, for the life of the process.
    const idleName = `homestead-logtest-idle-${Date.now()}`;
    try {
      // A container that prints one line then sleeps. A chatty container passes without
      // the fix because the next chunk arrives in milliseconds and the break fires.
      await run("docker", [
        "run",
        "-d",
        "--name",
        idleName,
        "alpine:3",
        "sh",
        "-c",
        "echo 'started'; sleep 3600",
      ]);

      const host = new LocalHost("local", "/tmp", "/var/run/docker.sock");
      await host.init();

      // Baseline: measure the active handle count before streaming.
      const baseline = (process as unknown as { _getActiveHandles(): unknown[] })
        ._getActiveHandles()
        .length;

      const abort = new AbortController();
      const lines: Array<{ text: string; stream: string }> = [];

      // Start streaming, consume one line, then abort.
      const iter = host.streamLogs({ containerId: idleName, follow: true, signal: abort.signal });
      for await (const line of iter) {
        lines.push(line);
        if (lines.length >= 1) {
          abort.abort();
          break;
        }
      }

      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines[0]?.text).toContain("started");

      // The Docker socket is closed and the handle count returns to baseline.
      // Without the fix, this would be baseline + 1 (the Docker stream).
      // Give the stream cleanup time to complete.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length,
      ).toBe(baseline);
    } finally {
      await run("docker", ["rm", "-f", idleName]).catch(() => {});
    }
  });

  it("projects exposed-but-unpublished ports to null, not zero", async () => {
    // Docker gives HostPort: "" for a port that is exposed but not published. Number("")
    // is 0, which is finite, so a naive coercion reports the app as reachable on port 0.
    // Mutation testing found that removing the guard left all FakeHost tests passing.
    const portTestName = `homestead-porttest-${Date.now()}`;
    try {
      // Expose 8080 but don't publish it.
      await run("docker", [
        "run",
        "-d",
        "--name",
        portTestName,
        "--expose",
        "8080",
        "alpine:3",
        "sleep",
        "60",
      ]);
      const host = new LocalHost("local", "/tmp", "/var/run/docker.sock");
      await host.init();
      const inspected = await host.inspectContainer(portTestName);
      const port8080 = inspected.ports.find((p) => p.container === 8080);
      expect(port8080).toBeDefined();
      // Not 0 — that would tell the user the app is reachable on port 0.
      expect(port8080?.host).toBeNull();
    } finally {
      await run("docker", ["rm", "-f", portTestName]).catch(() => {});
    }
  });
});
