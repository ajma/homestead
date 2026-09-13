import { createLocalJWKSet, decodeProtectedHeader, type JWK, jwtVerify } from "jose";

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
/** Floor on refetch frequency, so failed verifications cannot drive outbound requests. */
const MIN_JWKS_REFETCH_MS = 5 * 60 * 1000;

/** Exported for testing only - clears the JWKS cache */
export function clearJwksCache(): void {
  jwksCache.clear();
}

/**
 * Exported for testing only - injects a cache entry with a specific timestamp.
 *
 * Guarded rather than merely labelled: this writes arbitrary keys into the same
 * module-global cache `verifyAccessJwt` trusts for every request, under whatever team
 * domain the caller names. Phase 2E is what makes that cache a live authentication
 * trust store rather than dormant code, so an unguarded write path into it is worth
 * closing even though nothing production-reachable calls it today.
 */
export function injectJwksCache(teamDomain: string, keys: JWK[], fetchedAt: number): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("injectJwksCache is a test-only affordance and must not run outside tests");
  }
  jwksCache.set(teamDomain, { keys, fetchedAt });
}

/** The `kid` a token claims, read WITHOUT verification. Used only to route the refetch
 *  decision — never to decide whether the token is trustworthy. */
function decodeKid(token: string): string | undefined {
  try {
    return decodeProtectedHeader(token).kid;
  } catch {
    return undefined;
  }
}

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
  } catch (firstError) {
    // Refetching on failure supports Cloudflare's key rotation, but "verification
    // failed" and "my keys are stale" are indistinguishable from in here — so a naive
    // refetch lets unauthenticated callers drive our outbound request rate. Two gates
    // narrow it to the case that actually indicates rotation.
    //
    // Gate 1: the token's `kid` must be absent from the keys we already hold. A forged
    // or expired token naming a key we know is not a rotation, so it never refetches.
    // Reading the header unverified is safe here because it only routes this decision;
    // nothing is trusted from it.
    //
    // Gate 2: a cooldown, because an attacker can still mint tokens with random `kid`s.
    // Cloudflare rotates on the order of days, so refusing to refetch more than once
    // every few minutes costs nothing real.
    const presentedKid = decodeKid(opts.token);
    const kidIsKnown =
      presentedKid !== undefined && fresh.keys.some((key) => key.kid === presentedKid);
    const sinceLastFetch = Date.now() - fresh.fetchedAt;

    if (kidIsKnown || sinceLastFetch < MIN_JWKS_REFETCH_MS) throw firstError;

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
