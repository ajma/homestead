export type ImageRef = { registry: string; repository: string; reference: string };

const DEFAULT_REGISTRY = "registry-1.docker.io";

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
 * Splits an image reference into registry, repository and tag-or-digest.
 *
 * The first segment is a registry only if it looks like a host — it contains a dot or a
 * colon, or is exactly `localhost`. Otherwise `linuxserver/jellyfin` would parse as the
 * registry `linuxserver`. A single-segment name gets Docker Hub's implicit `library/`.
 */
export function parseImageRef(image: string): ImageRef {
  let rest = image;
  let registry = DEFAULT_REGISTRY;

  const slash = rest.indexOf("/");
  if (slash !== -1) {
    const head = rest.slice(0, slash);
    if (head === "localhost" || head.includes(".") || head.includes(":")) {
      registry = head;
      rest = rest.slice(slash + 1);
    }
  }

  let reference = "latest";
  const at = rest.indexOf("@");
  if (at !== -1) {
    reference = rest.slice(at + 1);
    rest = rest.slice(0, at);
  } else {
    const colon = rest.lastIndexOf(":");
    // A colon before a slash is a port on the host, not a tag — but the host has already
    // been stripped above, so any remaining colon after the last slash is a tag.
    if (colon !== -1 && colon > rest.lastIndexOf("/")) {
      reference = rest.slice(colon + 1);
      rest = rest.slice(0, colon);
    }
  }

  const repository =
    registry === DEFAULT_REGISTRY && !rest.includes("/") ? `library/${rest}` : rest;
  return { registry, repository, reference };
}

/** Parses `Bearer realm="…",service="…",scope="…"` into its parts. */
function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of header.matchAll(/([a-zA-Z]+)="([^"]*)"/g)) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined) out[key.toLowerCase()] = value;
  }
  return out;
}

export function createRegistryClient(deps: { fetch: typeof fetch }) {
  /**
   * The digest the registry currently serves for a tag, or `null`.
   *
   * `null` for every failure — a missing tag, a private registry, no network, a rate
   * limit. This runs daily across every service of every app, and one unreachable
   * registry must not fail the others or surface as an error the user has to dismiss.
   */
  async function latestDigest(image: string): Promise<string | null> {
    try {
      const ref = parseImageRef(image);
      const url = `https://${ref.registry}/v2/${ref.repository}/manifests/${ref.reference}`;
      const headers: Record<string, string> = { accept: ACCEPT };

      let response = await deps.fetch(url, { method: "HEAD", headers });

      if (response.status === 401) {
        const challenge = parseChallenge(response.headers.get("www-authenticate") ?? "");
        if (!challenge.realm) return null;

        const tokenUrl = new URL(challenge.realm);
        if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
        tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${ref.repository}:pull`);

        const tokenResponse = await deps.fetch(tokenUrl.toString(), { method: "GET" });
        if (!tokenResponse.ok) return null;
        const body = (await tokenResponse.json()) as { token?: string; access_token?: string };
        const token = body.token ?? body.access_token;
        if (!token) return null;

        headers.authorization = `Bearer ${token}`;
        // Exactly one retry. A registry that rejects its own token will keep doing so,
        // and a loop here would hammer it once per service per app.
        response = await deps.fetch(url, { method: "HEAD", headers });
      }

      if (!response.ok) return null;
      return response.headers.get("docker-content-digest");
    } catch {
      return null;
    }
  }

  return { latestDigest };
}
