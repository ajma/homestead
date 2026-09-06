import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildOverride } from "./translate.js";

const OPTS = {
  projectsDir: "/data/stacks",
  projectsHostDir: "/volume2/docker",
  slug: "media",
};

const canonical = (volumes: unknown) => ({
  name: "media",
  services: { web: { image: "nginx", volumes } },
});

describe("buildOverride", () => {
  it("returns null when the two roots are identical", () => {
    expect(
      buildOverride(canonical([]), {
        ...OPTS,
        projectsHostDir: OPTS.projectsDir,
      }),
    ).toBeNull();
  });

  it("rewrites a bind whose source is inside the project directory", () => {
    const out = buildOverride(
      canonical([
        {
          type: "bind",
          source: "/data/stacks/media/config",
          target: "/config",
        },
      ]),
      OPTS,
    );
    // biome-ignore lint/style/noNonNullAssertion: assertion is required for test
    expect(parse(out!)).toEqual({
      services: {
        web: {
          volumes: [
            {
              type: "bind",
              source: "/volume2/docker/media/config",
              target: "/config",
            },
          ],
        },
      },
    });
  });

  it("preserves read_only and bind options on a rewritten mount", () => {
    const out = buildOverride(
      canonical([
        {
          type: "bind",
          source: "/data/stacks/media/config",
          target: "/config",
          read_only: true,
        },
      ]),
      OPTS,
    );
    // biome-ignore lint/style/noNonNullAssertion: assertion is required for test
    expect(parse(out!).services.web.volumes[0].read_only).toBe(true);
  });

  it("leaves an absolute bind outside the projects root untouched", () => {
    const out = buildOverride(
      canonical([{ type: "bind", source: "/mnt/media", target: "/media" }]),
      OPTS,
    );
    expect(out).toBeNull();
  });

  it("leaves named volumes untouched", () => {
    const out = buildOverride(
      canonical([{ type: "volume", source: "appdata", target: "/data" }]),
      OPTS,
    );
    expect(out).toBeNull();
  });

  it("rewrites only the qualifying mounts in a mixed service", () => {
    const out = buildOverride(
      canonical([
        { type: "volume", source: "appdata", target: "/data" },
        {
          type: "bind",
          source: "/data/stacks/media/config",
          target: "/config",
        },
        { type: "bind", source: "/mnt/media", target: "/media" },
      ]),
      OPTS,
    );
    // biome-ignore lint/style/noNonNullAssertion: assertion is required for test
    const volumes = parse(out!).services.web.volumes;
    expect(volumes).toHaveLength(1);
    expect(volumes[0].source).toBe("/volume2/docker/media/config");
  });

  it("omits services that need no rewriting", () => {
    const json = {
      name: "media",
      services: {
        web: {
          volumes: [
            { type: "bind", source: "/data/stacks/media/w", target: "/w" },
          ],
        },
        db: {
          volumes: [
            {
              type: "volume",
              source: "pg",
              target: "/var/lib/postgresql/data",
            },
          ],
        },
      },
    };
    // biome-ignore lint/style/noNonNullAssertion: assertion is required for test
    expect(Object.keys(parse(buildOverride(json, OPTS)!).services)).toEqual([
      "web",
    ]);
  });

  it("does not rewrite a sibling directory that merely shares a prefix", () => {
    const out = buildOverride(
      canonical([
        {
          type: "bind",
          source: "/data/stacks/media-archive/x",
          target: "/x",
        },
      ]),
      OPTS,
    );
    expect(out).toBeNull();
  });

  it("rewrites the project directory itself, not only paths beneath it", () => {
    const out = buildOverride(
      canonical([
        { type: "bind", source: "/data/stacks/media", target: "/srv" },
      ]),
      OPTS,
    );
    // biome-ignore lint/style/noNonNullAssertion: assertion is required for test
    expect(parse(out!).services.web.volumes[0].source).toBe(
      "/volume2/docker/media",
    );
  });
});
