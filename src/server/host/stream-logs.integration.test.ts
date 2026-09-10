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
});
