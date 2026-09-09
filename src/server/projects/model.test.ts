import { describe, expect, it } from "vitest";
import { parseCanonical } from "./model.js";

// Shape produced by `docker compose config --format json` on Compose v2.
const CANONICAL = {
  name: "media",
  services: {
    jellyfin: {
      image: "jellyfin/jellyfin",
      labels: {
        "homestead.app.name": "Jellyfin",
        "homestead.app.icon": "jellyfin",
        "homestead.app.port": "8096",
        "homestead.app.path": "/web",
      },
      ports: [
        {
          mode: "ingress",
          target: 8096,
          published: "8096",
          protocol: "tcp",
          host_ip: "127.0.0.1",
        },
        { mode: "ingress", target: 8920, published: "8920", protocol: "tcp" },
      ],
    },
    db: {
      image: "postgres:17",
      labels: { "homestead.app.enabled": "false" },
      ports: [],
    },
    worker: { image: "busybox" },
  },
  "x-homestead": {
    schemaVersion: 1,
    displayName: "Media Stack",
    icon: "jellyfin",
  },
};

describe("parseCanonical", () => {
  it("reads the compose project name rather than deriving one", () => {
    expect(parseCanonical(CANONICAL).projectName).toBe("media");
  });

  it("normalises published ports and coerces the string port to a number", () => {
    const svc = parseCanonical(CANONICAL).services.find(
      (s) => s.name === "jellyfin",
    );
    expect(svc?.ports[0]).toEqual({
      hostIp: "127.0.0.1",
      hostPort: 8096,
      containerPort: 8096,
      protocol: "tcp",
      loopbackOnly: true,
    });
  });

  it("defaults a missing host_ip to 0.0.0.0 and marks it LAN-reachable", () => {
    const svc = parseCanonical(CANONICAL).services.find(
      (s) => s.name === "jellyfin",
    );
    expect(svc?.ports[1]).toEqual({
      hostIp: "0.0.0.0",
      hostPort: 8920,
      containerPort: 8920,
      protocol: "tcp",
      loopbackOnly: false,
    });
  });

  it("infers an app for a service with a published port", () => {
    const svc = parseCanonical(CANONICAL).services.find(
      (s) => s.name === "jellyfin",
    );
    expect(svc?.app).toEqual({
      name: "Jellyfin",
      icon: "jellyfin",
      port: 8096,
      path: "/web",
      enabled: true,
    });
  });

  it("suppresses the app when the label says so, even with labels present", () => {
    expect(
      parseCanonical(CANONICAL).services.find((s) => s.name === "db")?.app,
    ).toBeNull();
  });

  it("infers no app for a service with no published ports", () => {
    expect(
      parseCanonical(CANONICAL).services.find((s) => s.name === "worker")?.app,
    ).toBeNull();
  });

  it("falls back to the service name when no app name label is set", () => {
    const json = {
      name: "p",
      services: {
        grafana: {
          ports: [{ target: 3000, published: "3000", protocol: "tcp" }],
        },
      },
    };
    expect(parseCanonical(json).services[0]?.app?.name).toBe("grafana");
  });

  it("throws on input that is not a compose config", () => {
    expect(() => parseCanonical({ services: {} })).toThrow(/name/);
  });

  it("marks 127.0.0.2 as loopback-only", () => {
    const json = {
      name: "p",
      services: {
        web: {
          ports: [
            {
              target: 8080,
              published: "8080",
              protocol: "tcp",
              host_ip: "127.0.0.2",
            },
          ],
        },
      },
    };
    const port = parseCanonical(json).services[0]?.ports[0];
    expect(port?.loopbackOnly).toBe(true);
  });

  it("marks 127.1.1.1 as loopback-only", () => {
    const json = {
      name: "p",
      services: {
        web: {
          ports: [
            {
              target: 8080,
              published: "8080",
              protocol: "tcp",
              host_ip: "127.1.1.1",
            },
          ],
        },
      },
    };
    const port = parseCanonical(json).services[0]?.ports[0];
    expect(port?.loopbackOnly).toBe(true);
  });

  it("marks ::1 (IPv6 loopback) as loopback-only", () => {
    const json = {
      name: "p",
      services: {
        web: {
          ports: [
            {
              target: 8080,
              published: "8080",
              protocol: "tcp",
              host_ip: "::1",
            },
          ],
        },
      },
    };
    const port = parseCanonical(json).services[0]?.ports[0];
    expect(port?.loopbackOnly).toBe(true);
  });

  it("marks localhost as loopback-only", () => {
    const json = {
      name: "p",
      services: {
        web: {
          ports: [
            {
              target: 8080,
              published: "8080",
              protocol: "tcp",
              host_ip: "localhost",
            },
          ],
        },
      },
    };
    const port = parseCanonical(json).services[0]?.ports[0];
    expect(port?.loopbackOnly).toBe(true);
  });

  it("marks 0.0.0.0 (all interfaces) as not loopback-only", () => {
    const json = {
      name: "p",
      services: {
        web: {
          ports: [
            {
              target: 8080,
              published: "8080",
              protocol: "tcp",
              host_ip: "0.0.0.0",
            },
          ],
        },
      },
    };
    const port = parseCanonical(json).services[0]?.ports[0];
    expect(port?.loopbackOnly).toBe(false);
  });

  it("marks 192.168.1.50 (LAN address) as not loopback-only", () => {
    const json = {
      name: "p",
      services: {
        web: {
          ports: [
            {
              target: 8080,
              published: "8080",
              protocol: "tcp",
              host_ip: "192.168.1.50",
            },
          ],
        },
      },
    };
    const port = parseCanonical(json).services[0]?.ports[0];
    expect(port?.loopbackOnly).toBe(false);
  });

  describe("named volumes", () => {
    it("extracts top-level volume keys, sorted, with resolved names", () => {
      const json = {
        name: "media",
        services: {},
        volumes: { cache: null, appdata: { driver: "local" }, backups: null },
      };
      expect(parseCanonical(json).volumes).toEqual([
        { key: "appdata", name: "appdata", external: false },
        { key: "backups", name: "backups", external: false },
        { key: "cache", name: "cache", external: false },
      ]);
    });

    it("returns an empty array when there are no volumes", () => {
      expect(parseCanonical({ name: "p", services: {} }).volumes).toEqual([]);
    });

    it("ignores a volumes key that is not an object", () => {
      expect(
        parseCanonical({ name: "p", services: {}, volumes: "nonsense" })
          .volumes,
      ).toEqual([]);
    });

    it("keeps an explicit name: property instead of using the key", () => {
      const json = {
        name: "p",
        services: {},
        volumes: { mykey: { name: "custom-volume-name" } },
      };
      expect(parseCanonical(json).volumes).toEqual([
        { key: "mykey", name: "custom-volume-name", external: false },
      ]);
    });

    it("flags external: true volumes and preserves their unprefixed names", () => {
      const json = {
        name: "p",
        services: {},
        volumes: { ext: { external: true } },
      };
      expect(parseCanonical(json).volumes).toEqual([
        { key: "ext", name: "ext", external: true },
      ]);
    });

    it("handles null volume values gracefully without throwing", () => {
      const json = {
        name: "p",
        services: {},
        volumes: { pgdata: null },
      };
      expect(parseCanonical(json).volumes).toEqual([
        { key: "pgdata", name: "pgdata", external: false },
      ]);
    });
  });
});
