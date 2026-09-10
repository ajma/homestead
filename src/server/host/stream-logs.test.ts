import { FakeHost } from "@server/test-helpers";
import { describe, expect, it } from "vitest";

const collect = async (iterable: AsyncIterable<{ text: string }>) => {
  const seen: string[] = [];
  for await (const line of iterable) seen.push(line.text);
  return seen.join("");
};

describe("FakeHost.streamLogs", () => {
  it("replays scripted lines and ends", async () => {
    const host = new FakeHost();
    host.logLines.set("abc", [
      { text: "starting\n", stream: "stdout" },
      { text: "oops\n", stream: "stderr" },
    ]);
    const lines: Array<{ text: string; stream: string }> = [];
    for await (const line of host.streamLogs({ containerId: "abc" })) lines.push(line);
    expect(lines).toEqual([
      { text: "starting\n", stream: "stdout" },
      { text: "oops\n", stream: "stderr" },
    ]);
  });

  it("yields nothing for a container with no scripted output", async () => {
    expect(await collect(new FakeHost().streamLogs({ containerId: "quiet" }))).toBe("");
  });

  it("reports the requested container id so a route cannot silently ignore it", async () => {
    const host = new FakeHost();
    host.logLines.set("abc", [{ text: "x", stream: "stdout" }]);
    await collect(host.streamLogs({ containerId: "abc", tail: 50, follow: true }));
    expect(host.logCalls).toEqual([{ containerId: "abc", tail: 50, follow: true }]);
  });
});

describe("FakeHost.inspectContainer", () => {
  it("masks env values, never returning one", async () => {
    const host = new FakeHost();
    host.inspected.set("abc", {
      id: "abc",
      name: "jellyfin-web-1",
      image: "nginx:alpine",
      imageDigest: "sha256:aaa",
      state: "running",
      exitCode: null,
      oomKilled: false,
      startedAt: "2026-09-10T00:00:00Z",
      finishedAt: null,
      restartPolicy: "unless-stopped",
      restartCount: 0,
      tty: false,
      env: [
        { key: "DB_PASSWORD", masked: "••••••••" },
        { key: "EMPTY", masked: "" },
      ],
      mounts: [{ source: "/volume2/media", destination: "/media", mode: "ro", type: "bind" }],
      ports: [{ container: 80, host: 8099, protocol: "tcp" }],
      networks: ["jellyfin_default"],
      health: null,
    });
    const inspected = await host.inspectContainer("abc");
    expect(JSON.stringify(inspected)).not.toContain("hunter2");
    expect(inspected.env).toEqual([
      { key: "DB_PASSWORD", masked: "••••••••" },
      { key: "EMPTY", masked: "" },
    ]);
  });
});
