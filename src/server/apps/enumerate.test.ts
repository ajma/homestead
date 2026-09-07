import { describe, expect, it } from "vitest";
import { enumerateApps } from "./enumerate.js";

const cfg = (services: Record<string, unknown>) => ({ services });

describe("enumerateApps", () => {
  it("infers one app per service with a published port", () => {
    const apps = enumerateApps(
      "media",
      cfg({
        jellyfin: {
          ports: [
            {
              mode: "ingress",
              target: 8096,
              published: "8096",
              protocol: "tcp",
            },
          ],
        },
        sonarr: {
          ports: [
            {
              mode: "ingress",
              target: 8989,
              published: "8989",
              protocol: "tcp",
            },
          ],
        },
      }),
    );
    expect(apps).toEqual([
      {
        key: "media:jellyfin",
        projectSlug: "media",
        service: "jellyfin",
        hostPort: 8096,
      },
      {
        key: "media:sonarr",
        projectSlug: "media",
        service: "sonarr",
        hostPort: 8989,
      },
    ]);
  });

  it("ignores a service with no published port", () => {
    // A database is not an app. Nothing declares that; the absence of a
    // published port is the signal.
    const apps = enumerateApps(
      "media",
      cfg({
        postgres: { image: "postgres:16" },
      }),
    );
    expect(apps).toEqual([]);
  });

  it("suppresses a service that opts out", () => {
    const apps = enumerateApps(
      "media",
      cfg({
        redis: {
          ports: [
            {
              mode: "ingress",
              target: 6379,
              published: "6379",
              protocol: "tcp",
            },
          ],
          labels: { "homestead.app.enabled": "false" },
        },
      }),
    );
    expect(apps).toEqual([]);
  });

  it("uses the lowest published port when a service publishes several", () => {
    // One tile per service, not per port.
    const apps = enumerateApps(
      "media",
      cfg({
        app: {
          ports: [
            {
              mode: "ingress",
              target: 9000,
              published: "9000",
              protocol: "tcp",
            },
            {
              mode: "ingress",
              target: 8080,
              published: "8080",
              protocol: "tcp",
            },
          ],
        },
      }),
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]?.hostPort).toBe(8080);
  });

  it("prefers an explicitly labelled port over the lowest", () => {
    const apps = enumerateApps(
      "media",
      cfg({
        app: {
          ports: [
            {
              mode: "ingress",
              host_ip: "127.0.0.1",
              target: 9000,
              published: "9000",
              protocol: "tcp",
            },
            {
              mode: "ingress",
              target: 8080,
              published: "8080",
              protocol: "tcp",
            },
          ],
          labels: { "homestead.app.port": "9000" },
        },
      }),
    );
    expect(apps[0]?.hostPort).toBe(9000);
  });

  it("suppresses a service with case-insensitive false", () => {
    const apps = enumerateApps(
      "media",
      cfg({
        redis: {
          ports: [
            {
              mode: "ingress",
              target: 6379,
              published: "6379",
              protocol: "tcp",
            },
          ],
          labels: { "homestead.app.enabled": "False" },
        },
      }),
    );
    expect(apps).toEqual([]);
  });

  it("falls back to lowest port when labeled port is not published", () => {
    const apps = enumerateApps(
      "media",
      cfg({
        app: {
          ports: [
            {
              mode: "ingress",
              target: 8080,
              published: "8080",
              protocol: "tcp",
            },
            {
              mode: "ingress",
              target: 9000,
              published: "9000",
              protocol: "tcp",
            },
          ],
          labels: { "homestead.app.port": "7000" },
        },
      }),
    );
    expect(apps[0]?.hostPort).toBe(8080);
  });

  it("ignores a container-only port with no published field", () => {
    // A service declaring "8080" (container port, not published) has no
    // published field. This is the real "this is not an app" signal.
    const apps = enumerateApps(
      "media",
      cfg({
        postgres: {
          ports: [{ mode: "ingress", target: 5432, protocol: "tcp" }],
        },
      }),
    );
    expect(apps).toEqual([]);
  });

  it("returns nothing for a config it cannot understand", () => {
    // An unparseable or unexpected document must not throw into the caller,
    // which reconciles many projects in one pass.
    expect(enumerateApps("media", null)).toEqual([]);
    expect(enumerateApps("media", { services: "not-an-object" })).toEqual([]);
  });
});
