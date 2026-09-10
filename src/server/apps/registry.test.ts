import { createRegistryClient, parseImageRef } from "@server/apps/registry";
import { describe, expect, it } from "vitest";

describe("parseImageRef", () => {
  it.each([
    ["nginx", "registry-1.docker.io", "library/nginx", "latest"],
    ["nginx:alpine", "registry-1.docker.io", "library/nginx", "alpine"],
    ["linuxserver/jellyfin:latest", "registry-1.docker.io", "linuxserver/jellyfin", "latest"],
    [
      "ghcr.io/home-assistant/home-assistant:stable",
      "ghcr.io",
      "home-assistant/home-assistant",
      "stable",
    ],
    ["lscr.io/linuxserver/radarr", "lscr.io", "linuxserver/radarr", "latest"],
    ["localhost:5000/mine:v1", "localhost:5000", "mine", "v1"],
  ])("parses %s", (input, registry, repository, reference) => {
    expect(parseImageRef(input)).toEqual({ registry, repository, reference });
  });

  it.each([
    ["docker.io/library/postgres:16", "registry-1.docker.io", "library/postgres", "16"],
    ["index.docker.io/linuxserver/radarr", "registry-1.docker.io", "linuxserver/radarr", "latest"],
  ])(
    "rewrites %s to the host the v2 API actually lives on",
    (input, registry, repository, reference) => {
      // `docker.io` redirects to `registry-1.docker.io`, and `fetch` strips Authorization
      // across an origin change — so the authenticated retry would arrive unauthenticated
      // and 401 again. Compose files do write `docker.io/…`.
      expect(parseImageRef(input)).toEqual({ registry, repository, reference });
    },
  );

  it("takes the digest and drops the tag when a reference carries both", () => {
    // `nginx:1.25@sha256:…` is legal and common in pinned compose files. Taking only the
    // digest left `:1.25` inside the repository, giving `library/nginx:1.25` — a path no
    // registry answers.
    expect(parseImageRef("nginx:1.25@sha256:abc")).toEqual({
      registry: "registry-1.docker.io",
      repository: "library/nginx",
      reference: "sha256:abc",
    });
  });

  it.each([
    ["nginx:", "latest"],
    ["nginx", "latest"],
  ])("treats %s as an untagged reference", (input, reference) => {
    expect(parseImageRef(input).reference).toBe(reference);
  });

  it("keeps a digest reference as the reference", () => {
    expect(parseImageRef("nginx@sha256:abc")).toEqual({
      registry: "registry-1.docker.io",
      repository: "library/nginx",
      reference: "sha256:abc",
    });
  });

  it("does not mistake a port for a repository separator", () => {
    // `localhost:5000/mine` has a colon in the host, not a tag. Splitting on the last
    // colon without checking for a slash after it gets this wrong.
    expect(parseImageRef("localhost:5000/mine").reference).toBe("latest");
  });
});

describe("registry client", () => {
  const manifestDigest = "sha256:deadbeef";

  function fakeFetch(
    script: Array<{ status: number; headers: Record<string, string>; body?: unknown }>,
  ) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = script.shift();
      if (!next) throw new Error("unexpected extra fetch");
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: next.headers,
      });
    };
    return { impl: impl as unknown as typeof fetch, calls };
  }

  it("follows the challenge, fetches a token, and returns the digest", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
        },
      },
      { status: 200, headers: {}, body: { token: "tok-123" } },
      { status: 200, headers: { "docker-content-digest": manifestDigest } },
    ]);
    const client = createRegistryClient({ fetch: impl });
    expect(await client.latestDigest("nginx:alpine")).toBe(manifestDigest);

    expect(calls[0]?.url).toBe("https://registry-1.docker.io/v2/library/nginx/manifests/alpine");
    expect(calls[1]?.url).toContain("https://auth.docker.io/token?");
    expect(calls[1]?.url).toContain("scope=repository%3Alibrary%2Fnginx%3Apull");
    expect((calls[2]?.init?.headers as Record<string, string>)?.authorization).toBe(
      "Bearer tok-123",
    );
    // Manifest lists AND single manifests, or a multi-arch image returns 404.
    const accept = (calls[2]?.init?.headers as Record<string, string>)?.accept ?? "";
    expect(accept).toContain("application/vnd.docker.distribution.manifest.list.v2+json");
    expect(accept).toContain("application/vnd.oci.image.index.v1+json");
    expect(calls[2]?.init?.method).toBe("HEAD");
  });

  it("uses the digest directly when the registry needs no auth", async () => {
    const { impl } = fakeFetch([
      { status: 200, headers: { "docker-content-digest": manifestDigest } },
    ]);
    expect(await createRegistryClient({ fetch: impl }).latestDigest("localhost:5000/mine:v1")).toBe(
      manifestDigest,
    );
  });

  it("returns null rather than throwing when the manifest is missing", async () => {
    const { impl } = fakeFetch([{ status: 404, headers: {} }]);
    expect(await createRegistryClient({ fetch: impl }).latestDigest("nginx:nope")).toBeNull();
  });

  it("returns null when the registry answers without a digest header", async () => {
    const { impl } = fakeFetch([{ status: 200, headers: {} }]);
    expect(await createRegistryClient({ fetch: impl }).latestDigest("nginx")).toBeNull();
  });

  it("reports a reason for every failure, so a broken registry is diagnosable", async () => {
    // `latestDigest` returns null for everything by design, so without this hook a
    // systematically broken registry is silent across a daily sweep of every service of
    // every app.
    const reasons: Array<[string, string]> = [];
    const onError = (image: string, reason: string) => reasons.push([image, reason]);

    const { impl } = fakeFetch([{ status: 404, headers: {} }]);
    expect(await createRegistryClient({ fetch: impl, onError }).latestDigest("nginx")).toBeNull();

    const throwing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    await createRegistryClient({ fetch: throwing, onError }).latestDigest("ghcr.io/x/y");

    await createRegistryClient({ fetch: impl, onError }).latestDigest("");

    expect(reasons.map(([image]) => image)).toEqual(["nginx", "ghcr.io/x/y", ""]);
    expect(reasons[0]?.[1]).toContain("404");
    expect(reasons[1]?.[1]).toContain("ENOTFOUND");
    expect(reasons[2]?.[1]).toContain("cannot parse");
  });

  it("reads an unquoted challenge parameter", async () => {
    // RFC 9110 allows a bare token. Every registry in practice quotes, but a parser that
    // only reads quoted values returns nothing — indistinguishable from needing no auth.
    const { impl } = fakeFetch([
      {
        status: 401,
        headers: { "www-authenticate": "Bearer realm=https://auth.example/token,service=reg" },
      },
      { status: 200, headers: {}, body: { token: "tok" } },
      { status: 200, headers: { "docker-content-digest": "sha256:ok" } },
    ]);
    expect(await createRegistryClient({ fetch: impl }).latestDigest("nginx")).toBe("sha256:ok");
  });

  it("ignores a non-Bearer challenge rather than guessing", async () => {
    const { impl } = fakeFetch([
      { status: 401, headers: { "www-authenticate": 'Basic realm="private"' } },
    ]);
    expect(await createRegistryClient({ fetch: impl }).latestDigest("nginx")).toBeNull();
  });

  it("returns null when the network fails, rather than failing the whole check", async () => {
    const failing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await createRegistryClient({ fetch: failing }).latestDigest("nginx")).toBeNull();
  });

  it("gives up rather than looping when the token is rejected too", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://auth.example/token",service="s"' },
      },
      { status: 200, headers: {}, body: { token: "tok" } },
      {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://auth.example/token",service="s"' },
      },
    ]);
    expect(await createRegistryClient({ fetch: impl }).latestDigest("nginx")).toBeNull();
    expect(calls).toHaveLength(3);
  });
});
