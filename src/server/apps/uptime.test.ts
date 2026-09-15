import { describe, expect, it } from "vitest";
import type { ContainerInspect, ContainerSummary } from "../host/types.js";
import { FakeHost } from "../test-helpers.js";
import { oldestStartTimes } from "./uptime.js";

function container(over: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: "c1",
    names: ["c1"],
    image: "nginx",
    state: "running",
    status: "Up 2 hours",
    project: "p",
    service: "web",
    labels: {},
    ...over,
  };
}

function inspect(over: Partial<ContainerInspect> = {}): ContainerInspect {
  return {
    id: "c1",
    name: "c1",
    image: "nginx",
    imageDigest: null,
    state: "running",
    exitCode: null,
    oomKilled: false,
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: null,
    restartPolicy: "no",
    restartCount: 0,
    tty: false,
    env: [],
    mounts: [],
    ports: [],
    networks: [],
    health: null,
    ...over,
  };
}

describe("oldestStartTimes", () => {
  it("reports the oldest running container's start time for a project", async () => {
    const host = new FakeHost();
    host.containers = [container({ id: "old" }), container({ id: "new" })];
    host.inspected.set("old", inspect({ id: "old", startedAt: "2024-01-01T00:00:00.000Z" }));
    host.inspected.set("new", inspect({ id: "new", startedAt: "2024-06-01T00:00:00.000Z" }));

    const result = await oldestStartTimes(
      host,
      new Map([["p", [container({ id: "old" }), container({ id: "new" })]]]),
    );

    expect(result.get("p")).toBe(Math.floor(Date.parse("2024-01-01T00:00:00.000Z") / 1000));
  });

  it("has no entry for a key with no running container", async () => {
    const host = new FakeHost();
    const stopped = container({ id: "c1", state: "exited" });

    const result = await oldestStartTimes(host, new Map([["p", [stopped]]]));

    expect(result.has("p")).toBe(false);
  });

  it("has no entry for a project with no containers at all", async () => {
    const host = new FakeHost();
    const result = await oldestStartTimes(host, new Map([["p", []]]));
    expect(result.has("p")).toBe(false);
  });

  it("ignores a container that vanished between listContainers and inspectContainer", async () => {
    // `FakeHost.inspectContainer` throws for an id it has no scripted `inspect` for —
    // the same shape a real `inspectContainer` throws for a container removed a moment
    // ago. Not fatal: the app simply reports no uptime from this one container, rather
    // than the whole page's Uptime column erroring out.
    const host = new FakeHost();
    const result = await oldestStartTimes(host, new Map([["p", [container({ id: "gone" })]]]));
    expect(result.has("p")).toBe(false);
  });

  it("does not call inspectContainer for a container listContainers already reported as not running", async () => {
    const host = new FakeHost();
    const stopped = container({ id: "c1", state: "exited" });
    await oldestStartTimes(host, new Map([["p", [stopped]]]));
    expect(host.inspectCalls).toHaveLength(0);
  });

  it("ignores a container inspectContainer itself reports as no longer running", async () => {
    // `listContainers` and `inspectContainer` are two separate Docker calls; a container
    // can stop in between. `inspect.state` is the fresher of the two reads.
    const host = new FakeHost();
    host.inspected.set("c1", inspect({ state: "exited" }));
    const result = await oldestStartTimes(
      host,
      new Map([["p", [container({ id: "c1", state: "running" })]]]),
    );
    expect(result.has("p")).toBe(false);
  });

  it("bounds concurrency rather than inspecting every container at once", async () => {
    const host = new FakeHost();
    const containers = Array.from({ length: 12 }, (_, i) => container({ id: `c${i}` }));
    for (const c of containers) {
      host.inspected.set(c.id, inspect({ id: c.id }));
    }
    let maxConcurrent = 0;
    let current = 0;
    const originalInspect = host.inspectContainer.bind(host);
    host.inspectContainer = async (id: string) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      const result = await originalInspect(id);
      current--;
      return result;
    };

    await oldestStartTimes(host, new Map([["p", containers]]));

    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });

  it("takes every container across every key into one bounded batch, not one batch per key", async () => {
    // Two projects, four containers each (eight total, over the concurrency limit of
    // five): if concurrency were bounded per key rather than globally, both keys'
    // batches could run at once and this would allow eight simultaneous inspects. It
    // must not — five is the real ceiling on simultaneous Docker calls this function
    // promises.
    const host = new FakeHost();
    const byKey = new Map<string, ContainerSummary[]>();
    for (const key of ["p1", "p2"]) {
      const containers = Array.from({ length: 4 }, (_, i) => container({ id: `${key}-${i}` }));
      for (const c of containers) host.inspected.set(c.id, inspect({ id: c.id }));
      byKey.set(key, containers);
    }
    let maxConcurrent = 0;
    let current = 0;
    const originalInspect = host.inspectContainer.bind(host);
    host.inspectContainer = async (id: string) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      const result = await originalInspect(id);
      current--;
      return result;
    };

    await oldestStartTimes(host, byKey);

    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });
});
