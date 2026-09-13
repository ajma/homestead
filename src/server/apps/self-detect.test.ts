import { FakeHost } from "@server/test-helpers";
import type { ContainerSummary } from "@shared/admin";
import { describe, expect, it } from "vitest";
import { detectSelfDirectory, extractSelfContainerId } from "./self-detect";

const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";

/**
 * Captured verbatim (only the log-noise `docker compose` prints around the container's
 * own output stripped) from:
 *
 *     docker compose -f docker-compose.yml up   # network_mode: host, image alpine:3
 *     # docker-compose.yml: services.homestead.{image: alpine:3, network_mode: host,
 *     #   command: ["sh", "-c", "cat /proc/self/mountinfo"]}
 *
 * on Docker 29.8.0 — the exact `network_mode: host` shape `compose.example.yaml:99`
 * mandates for Homestead's own deployment, which is precisely the configuration the
 * Phase 2F whole-branch review found `$HOSTNAME`-based detection could never fire under
 * (F1). This is "the production value" the review said no test had ever put in coverage:
 * a real container's real mount table under real host networking, not a synthetic
 * `HOSTNAME` literal chosen to match a fixture container id by construction.
 *
 * The container's own id, confirmed independently via `docker inspect --format
 * '{{.Id}}'` against the running container at capture time, was
 * `ea3b3a00a57231354f3b27e748f2e224b34537a5911a205f835c7cb4c6551de1` — matching what
 * appears in the `hostname`/`hosts`/`resolv.conf` lines below.
 */
const REAL_MOUNTINFO_UNDER_HOST_NETWORKING = `
325 285 0:43 / / rw,relatime - overlay overlay rw,lowerdir=/a:/b,upperdir=/c,workdir=/d
327 325 0:57 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
328 325 0:64 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755,inode64
329 328 0:65 / /dev/pts rw,nosuid,noexec,relatime - devpts devpts rw,gid=5,mode=620,ptmxmode=666
330 325 0:25 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs rw
331 330 0:30 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw,nsdelegate,memory_recursiveprot
332 328 0:54 / /dev/mqueue rw,nosuid,nodev,noexec,relatime - mqueue mqueue rw
333 328 0:66 / /dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=65536k,inode64
334 325 8:1 /var/lib/docker/containers/ea3b3a00a57231354f3b27e748f2e224b34537a5911a205f835c7cb4c6551de1/hostname /etc/hostname rw,relatime - ext4 /dev/root rw,discard,errors=remount-ro,commit=30
335 325 8:1 /var/lib/docker/containers/ea3b3a00a57231354f3b27e748f2e224b34537a5911a205f835c7cb4c6551de1/hosts /etc/hosts rw,relatime - ext4 /dev/root rw,discard,errors=remount-ro,commit=30
336 325 8:1 /var/lib/docker/containers/ea3b3a00a57231354f3b27e748f2e224b34537a5911a205f835c7cb4c6551de1/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/root rw,discard,errors=remount-ro,commit=30
286 327 0:57 /bus /proc/bus ro,nosuid,nodev,noexec,relatime - proc proc rw
287 327 0:57 /fs /proc/fs ro,nosuid,nodev,noexec,relatime - proc proc rw
298 330 0:67 / /sys/firmware ro,relatime - tmpfs tmpfs ro,size=4k,nr_inodes=1,inode64
`;

const REAL_CONTAINER_ID = "ea3b3a00a57231354f3b27e748f2e224b34537a5911a205f835c7cb4c6551de1";

/** A bare-metal `pnpm dev` process's own `/proc/self/mountinfo` has plenty of mount
 * lines, but never Docker's `containers/<id>/...` bind mounts — captured from this
 * machine's own shell, not fabricated, to keep the negative case honest too. */
const REAL_MOUNTINFO_OUTSIDE_A_CONTAINER = `
25 30 0:5 / /proc rw,nosuid,nodev,noexec,relatime shared:4 - proc proc rw
26 30 0:23 / /sys rw,nosuid,nodev,noexec,relatime shared:5 - sysfs sysfs rw
28 30 0:6 / /dev rw,nosuid shared:2 - devtmpfs devtmpfs rw,size=4096k,nr_inodes=1048576
30 1 259:2 /home /home rw,relatime shared:1 - ext4 /dev/root rw
`;

function container(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: REAL_CONTAINER_ID,
    names: ["homestead"],
    image: "homestead:latest",
    state: "running",
    status: "Up",
    project: "homestead",
    service: "homestead",
    labels: {},
    ...overrides,
  };
}

describe("extractSelfContainerId", () => {
  it("finds the container id in real mountinfo captured under network_mode: host", () => {
    expect(extractSelfContainerId(REAL_MOUNTINFO_UNDER_HOST_NETWORKING)).toBe(REAL_CONTAINER_ID);
  });

  it("finds nothing in real mountinfo captured outside any container", () => {
    expect(extractSelfContainerId(REAL_MOUNTINFO_OUTSIDE_A_CONTAINER)).toBeNull();
  });

  it("finds nothing in empty mountinfo", () => {
    expect(extractSelfContainerId("")).toBeNull();
  });
});

describe("detectSelfDirectory", () => {
  it(
    "resolves the self directory from real mountinfo under host networking, matched " +
      "against listContainers by full id — the case $HOSTNAME could never reach",
    async () => {
      const host = new FakeHost();
      host.containers = [
        container({ labels: { [WORKING_DIR_LABEL]: "/volume2/docker/homestead" } }),
      ];

      const result = await detectSelfDirectory({
        host,
        composeRoot: "/volume2/docker",
        readMountinfo: async () => REAL_MOUNTINFO_UNDER_HOST_NETWORKING,
      });
      expect(result).toBe("homestead");
    },
  );

  it("finds nothing outside a container — no mountinfo match, no guess", async () => {
    const host = new FakeHost();
    host.containers = [container({ labels: { [WORKING_DIR_LABEL]: "/volume2/docker/homestead" } })];

    const result = await detectSelfDirectory({
      host,
      composeRoot: "/volume2/docker",
      readMountinfo: async () => REAL_MOUNTINFO_OUTSIDE_A_CONTAINER,
    });
    expect(result).toBeNull();
  });

  it("finds nothing when /proc/self/mountinfo cannot be read at all", async () => {
    const host = new FakeHost();
    host.containers = [container({ labels: { [WORKING_DIR_LABEL]: "/volume2/docker/homestead" } })];

    const result = await detectSelfDirectory({
      host,
      composeRoot: "/volume2/docker",
      readMountinfo: async () => null,
    });
    expect(result).toBeNull();
  });

  it("finds nothing when the extracted id matches no known container", async () => {
    const host = new FakeHost();
    host.containers = [container({ id: "0".repeat(64) })];

    const result = await detectSelfDirectory({
      host,
      composeRoot: "/volume2/docker",
      readMountinfo: async () => REAL_MOUNTINFO_UNDER_HOST_NETWORKING,
    });
    expect(result).toBeNull();
  });

  it("never guesses when the Docker socket is unreachable — F4, never a 500", async () => {
    const host = new FakeHost();
    host.listContainers = async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };

    const result = await detectSelfDirectory({
      host,
      composeRoot: "/volume2/docker",
      readMountinfo: async () => REAL_MOUNTINFO_UNDER_HOST_NETWORKING,
    });
    expect(result).toBeNull();
  });

  it("finds nothing when the matched container carries no compose working-dir label", async () => {
    // A container that is not itself a `docker compose` service — or one Docker Compose
    // labelled differently than this version stamps — must not produce a guess.
    const host = new FakeHost();
    host.containers = [container({ labels: {} })];

    const result = await detectSelfDirectory({
      host,
      composeRoot: "/volume2/docker",
      readMountinfo: async () => REAL_MOUNTINFO_UNDER_HOST_NETWORKING,
    });
    expect(result).toBeNull();
  });

  it("finds nothing when the working directory IS the compose root itself", async () => {
    const host = new FakeHost();
    host.containers = [container({ labels: { [WORKING_DIR_LABEL]: "/volume2/docker" } })];

    const result = await detectSelfDirectory({
      host,
      composeRoot: "/volume2/docker",
      readMountinfo: async () => REAL_MOUNTINFO_UNDER_HOST_NETWORKING,
    });
    expect(result).toBeNull();
  });

  it("finds nothing when the working directory sits outside the compose root", async () => {
    const host = new FakeHost();
    host.containers = [
      container({ labels: { [WORKING_DIR_LABEL]: "/some/other/place/homestead" } }),
    ];

    const result = await detectSelfDirectory({
      host,
      composeRoot: "/volume2/docker",
      readMountinfo: async () => REAL_MOUNTINFO_UNDER_HOST_NETWORKING,
    });
    expect(result).toBeNull();
  });

  it("resolves a nested directory relative to the compose root", async () => {
    const host = new FakeHost();
    host.containers = [
      container({ labels: { [WORKING_DIR_LABEL]: "/volume2/docker/infra/homestead" } }),
    ];

    const result = await detectSelfDirectory({
      host,
      composeRoot: "/volume2/docker",
      readMountinfo: async () => REAL_MOUNTINFO_UNDER_HOST_NETWORKING,
    });
    expect(result).toBe("infra/homestead");
  });

  it("defaults to reading the real /proc/self/mountinfo when not overridden", async () => {
    // No `readMountinfo` override — exercises the actual default path against whatever
    // this test process's own mount table is. On every machine this suite runs on
    // (bare host or an unrelated CI container), it is not Homestead's own container, so
    // this must resolve to `null` rather than throw or hang.
    const host = new FakeHost();
    host.containers = [container()];

    const result = await detectSelfDirectory({ host, composeRoot: "/volume2/docker" });
    expect(result).toBeNull();
  });
});
