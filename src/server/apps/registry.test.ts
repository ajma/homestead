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
