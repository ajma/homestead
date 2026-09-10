import { createLocalJWKSet, type JWK, jwtVerify } from "jose";
import type { Config } from "../config.js";

export type JwksFetcher = () => Promise<{ keys: JWK[] }>;

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

function defaultFetcher(teamDomain: string): JwksFetcher {
  return async () => {
    const res = await fetch(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Failed to fetch Access JWKS: ${res.status}`);
    return (await res.json()) as { keys: JWK[] };
  };
}

const jwksCache = new Map<string, { keys: JWK[]; fetchedAt: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * Verifies a Cloudflare Access JWT.
 *
 * The `aud` check is not optional. Every Access application in an account is
 * signed by the same team keys with the same issuer, so signature validity alone
 * proves only that the bearer may access *something* in this account.
 */
export async function verifyAccessJwt(opts: {
  token: string;
  teamDomain: string;
  aud: string;
  fetchJwks?: JwksFetcher;
}): Promise<{ email: string }> {
  const fetcher = opts.fetchJwks ?? defaultFetcher(opts.teamDomain);

  const cached = jwksCache.get(opts.teamDomain);
  const fresh =
    cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS
      ? cached
      : { keys: (await fetcher()).keys, fetchedAt: Date.now() };
  jwksCache.set(opts.teamDomain, fresh);

  const verify = async (keys: JWK[]) =>
    jwtVerify(opts.token, createLocalJWKSet({ keys }), {
      issuer: `https://${opts.teamDomain}.cloudflareaccess.com`,
      audience: opts.aud,
    });

  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    payload = (await verify(fresh.keys)).payload;
  } catch {
    // An unknown `kid` may mean Cloudflare rotated keys. Refetch once.
    const refreshed = { keys: (await fetcher()).keys, fetchedAt: Date.now() };
    jwksCache.set(opts.teamDomain, refreshed);
    payload = (await verify(refreshed.keys)).payload;
  }

  const email = payload.email;
  if (typeof email !== "string" || email === "") {
    throw new Error("Access token carries no email claim");
  }
  return { email };
}

/** True only when both configuration values are present. */
export function isAccessEnabled(config: Config): boolean {
  return config.accessEnabled;
}
