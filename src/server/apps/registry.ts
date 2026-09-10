export type ImageRef = { registry: string; repository: string; reference: string };

const DEFAULT_REGISTRY = "registry-1.docker.io";

/**
 * How long to wait for a registry response before giving up.
 *
 * `POST /images/check` runs the whole loop inside the request, and 1C will run it across
 * every app, so one registry that accepts a connection and then says nothing stalls the
 * sweep. 10s is enough for a distant private registry yet short enough to prevent the
 * whole check from hanging indefinitely.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Every media type a manifest endpoint might answer with.
 *
 * Without the list and index types a multi-arch image — which is most of them — returns
 * 404 or the wrong digest, because the registry falls back to whatever single manifest it
 * thinks the client can read.
 */
const ACCEPT = [
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

/**
 * Hostnames that mean Docker Hub but are not where its v2 API lives.
 *
 * `https://docker.io/v2/…` redirects to `registry-1.docker.io`, and `fetch` strips the
 * `Authorization` header across an origin change — so the authenticated retry after the
 * token exchange arrives unauthenticated and 401s again. Compose files do write
 * `docker.io/…`, so this is reachable, not theoretical.
 */
const HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry.hub.docker.com"]);

/**
 * Splits an image reference into registry, repository and tag-or-digest.
 *
 * The first segment is a registry only if it looks like a host — it contains a dot or a
 * colon, or is exactly `localhost`. Otherwise `linuxserver/jellyfin` would parse as the
 * registry `linuxserver`. A single-segment name gets Docker Hub's implicit `library/`.
 */
export function parseImageRef(image: string): ImageRef {
  let rest = image.trim().replace(/^\/+/, "");
  let registry = DEFAULT_REGISTRY;

  const slash = rest.indexOf("/");
  if (slash !== -1) {
    const head = rest.slice(0, slash);
    if (head === "localhost" || head.includes(".") || head.includes(":")) {
      registry = HUB_ALIASES.has(head) ? DEFAULT_REGISTRY : head;
      rest = rest.slice(slash + 1);
    }
  }

  let reference = "latest";
  // Digest first, then tag from whatever is left. `nginx:1.25@sha256:…` is legal and
  // common in pinned compose files; taking only the digest left `:1.25` inside the
  // repository, producing `library/nginx:1.25` and a request URL no registry answers.
  const at = rest.indexOf("@");
  if (at !== -1) {
    reference = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const colon = rest.lastIndexOf(":");
  // A colon before a slash would be a host port, but the host is already stripped, so
  // any colon after the last slash is a tag.
  if (colon !== -1 && colon > rest.lastIndexOf("/")) {
    const tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    // A digest already claimed `reference`; a bare `nginx:` names no tag at all.
    if (at === -1 && tag !== "") reference = tag;
  }

  const repository =
    registry === DEFAULT_REGISTRY && !rest.includes("/") ? `library/${rest}` : rest;
  return { registry, repository, reference };
}

/**
 * Parses `Bearer realm="…",service="…",scope="…"` into its parts.
 *
 * Values may be unquoted — RFC 9110 allows a bare token — and every registry in practice
 * quotes them, but a parser that only reads quoted values returns nothing for the ones
 * that do not, which looks identical to a registry needing no auth.
 */
function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  // RFC 9110 lets one header offer several schemes — `Basic realm="x", Bearer realm="y"`
  // is legal. Requiring the header to START with Bearer threw away the Bearer option in
  // that case, so we find it wherever it appears and read the parameters after it.
  const bearer = /\bBearer\b/i.exec(header);
  if (!bearer) return out;
  for (const match of header
    .slice(bearer.index)
    .matchAll(/([a-zA-Z_]+)=(?:"([^"]*)"|([^\s,]+))/g)) {
    const [, key, quoted, bare] = match;
    const value = quoted ?? bare;
    if (key !== undefined && value !== undefined) out[key.toLowerCase()] = value;
  }
  return out;
}

export function createRegistryClient(deps: {
  fetch: typeof fetch;
  /**
   * Called once per failed lookup with the reason.
   *
   * `latestDigest` deliberately returns `null` for everything, so without this a
   * systematically broken registry — a typo'd private host, expired credentials, a rate
   * limit — is completely silent across a daily sweep of every service of every app. The
   * caller decides whether to log; this module stays free of a logger dependency.
   */
  onError?: (image: string, reason: string) => void;
}) {
  /**
   * The digest the registry currently serves for a tag, or `null`.
   *
   * `null` for every failure — a missing tag, a private registry, no network, a rate
   * limit. This runs daily across every service of every app, and one unreachable
   * registry must not fail the others or surface as an error the user has to dismiss.
   */
  async function latestDigest(image: string): Promise<string | null> {
    const fail = (reason: string): null => {
      // The callback is the caller's logger. If it throws, the throw would escape
      // `latestDigest` and abort the daily sweep for every app after this one — a
      // reporting channel taking down the thing it reports on. Same shape as a `finally`
      // that masks the error it was added to surface.
      try {
        deps.onError?.(image, reason);
      } catch {
        // Nothing useful to do: the channel for saying so is the one that just failed.
      }
      return null;
    };
    try {
      const ref = parseImageRef(image);
      // A reference we cannot build a URL from is a configuration error, not a network
      // one, and saying so is more useful than a 404 from a nonsense path.
      if (ref.repository === "" || ref.repository.endsWith("/") || ref.reference === "") {
        return fail(`cannot parse image reference "${image}"`);
      }
      const url = `https://${ref.registry}/v2/${ref.repository}/manifests/${ref.reference}`;
      const headers: Record<string, string> = { accept: ACCEPT };

      let response = await deps.fetch(url, {
        method: "HEAD",
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 401) {
        const challenge = parseChallenge(response.headers.get("www-authenticate") ?? "");
        if (!challenge.realm) return fail("401 without a usable Bearer challenge");

        const tokenUrl = new URL(challenge.realm);
        if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
        tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${ref.repository}:pull`);

        const tokenResponse = await deps.fetch(tokenUrl.toString(), {
          method: "GET",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!tokenResponse.ok) return fail(`token endpoint returned ${tokenResponse.status}`);
        const body = (await tokenResponse.json()) as { token?: string; access_token?: string };
        const token = body.token ?? body.access_token;
        if (!token) return fail("token endpoint returned no token");

        headers.authorization = `Bearer ${token}`;
        // Exactly one retry. A registry that rejects its own token will keep doing so,
        // and a loop here would hammer it once per service per app.
        response = await deps.fetch(url, {
          method: "HEAD",
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      }

      if (!response.ok) return fail(`manifest request returned ${response.status}`);
      const digest = response.headers.get("docker-content-digest");
      return digest ?? fail("registry answered without a Docker-Content-Digest header");
    } catch (error) {
      return fail(error instanceof Error ? error.message : "registry request failed");
    }
  }

  return { latestDigest };
}
