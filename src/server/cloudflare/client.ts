import type { CloudflareFault, CloudflareTunnel, IngressRule } from "@shared/cloudflare.js";
import { z } from "zod";
import { CloudflareError } from "./errors.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

/** Bounded so a struggling API gets a handful of attempts, not an unbounded hammer:
 * the original call plus two retries. */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

/**
 * A page cap for `listZones`, independent of `MAX_ATTEMPTS` (which bounds retries of one
 * page, not how many pages are walked). 50 pages at Cloudflare's 50-per-page default is
 * 2,500 zones — far beyond a real account on this project's single-NAS scale — while
 * still failing within seconds, not hanging the request forever, if the API ignores
 * `?page=` and keeps answering the same page (see `listZones` below).
 */
const MAX_PAGES = 50;

/**
 * Which faults are worth retrying, and why the rest are not.
 *
 * `rate_limit` and `cloudflare` (Cloudflare's own 5xx, a body that isn't the v4 envelope
 * at all, or any other failure `classifyFault` doesn't otherwise recognise) are treated
 * as transient by default — retrying something unclassifiable costs three attempts
 * against Cloudflare, and the alternative is guessing wrong about a cause we cannot name.
 * `network` — `fetch` never reaching Cloudflare — is exactly as transient. `auth` and
 * `permission` are properties of the TOKEN, not the moment: an expired token or a scope
 * it never had is still expired or missing on the next attempt, and retrying it three
 * times only delays the message an admin needs to act on. `client` means the request WE
 * sent was malformed; Cloudflare will reject the identical retry the same way.
 *
 * This set is the ONLY place that decision lives — both branches in `requestPage` below
 * (the parsed-envelope failure path and the transport-failure `catch`) read it directly
 * rather than each hard-coding their own notion of what to retry, so removing a fault
 * from here actually changes behaviour instead of leaving a decorative constant next to
 * code that never consulted it.
 */
const RETRYABLE_FAULTS: ReadonlySet<CloudflareFault> = new Set([
  "rate_limit",
  "cloudflare",
  "network",
]);

const errorSchema = z.object({ code: z.number(), message: z.string() });

/**
 * `result_info` requires only `page`, `per_page` and `total_count` — the three fields
 * the plan's "known and safe to rely on" list actually names. A fourth field Cloudflare
 * sometimes sends, `count`, is NOT on that list and this client does not use it for
 * anything; requiring it anyway would fail the whole envelope parse (including a
 * perfectly good `result` array) the moment Cloudflare's response omits or renames it.
 * zod already drops fields this object doesn't declare without complaint, so leaving
 * `count` out is enough to tolerate it, not merely to make it optional.
 */
const envelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(errorSchema).default([]),
  result: z.unknown().optional(),
  result_info: z
    .object({
      page: z.number(),
      per_page: z.number(),
      total_count: z.number(),
    })
    .optional(),
});

const zoneSchema = z.object({ id: z.string(), name: z.string() });
const zonesResultSchema = z.array(zoneSchema);

/**
 * `deleted_at` is Cloudflare's documented field for a soft-deleted tunnel — present and
 * null for a live tunnel, an ISO8601 timestamp once deleted. Unlike the token response
 * (see `tunnelTokenResultSchema` below), this shape is not on the plan's "unverified"
 * list, so it is trusted directly rather than defended against alternate shapes.
 */
const tunnelSchema = z.object({
  id: z.string(),
  name: z.string(),
  deleted_at: z.string().nullable().optional(),
});
const tunnelsResultSchema = z.array(tunnelSchema);

/**
 * The tunnel-token endpoint's response shape is explicitly unverified (see the plan's
 * "what is known" section) — Cloudflare's docs and its own examples disagree on whether
 * `result` is the bare token string or `{ token: string }`. Both are accepted here rather
 * than guessing one; whichever shape arrives, `tunnelToken` below still enforces a
 * non-empty string, so an API change to a THIRD shape fails the parse loudly instead of
 * handing back `undefined` as if it were a token (Phase 1F's missing-Docker-version
 * defect, generalised).
 */
const tunnelTokenResultSchema = z.union([z.string(), z.object({ token: z.string() })]);

/** ISO8601 → epoch ms, or `null` for a value Cloudflare did not send. Raises rather than
 * returning `NaN` silently: an unparseable date is Cloudflare sending a shape this client
 * does not understand, not a value safe to carry forward. `field` names which response
 * field this was, so the error is specific (`deleted_at` vs `expires_at`) rather than a
 * generic "date I don't understand" that gives an admin nothing to search for. */
function parseIsoOrNull(raw: string | null | undefined, field: string): number | null {
  if (raw === null || raw === undefined) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new CloudflareError(
      "cloudflare",
      `Cloudflare's response carried a ${field} that could not be parsed as a date`,
      { status: null, codes: [] },
    );
  }
  return ms;
}

function toTunnel(raw: z.infer<typeof tunnelSchema>): CloudflareTunnel {
  return { id: raw.id, name: raw.name, deletedAt: parseIsoOrNull(raw.deleted_at, "deleted_at") };
}

const ingressRuleSchema = z.object({ hostname: z.string().optional(), service: z.string() });

/**
 * Only `config.ingress` is read from this — `result` also carries `tunnel_id` and
 * `version`, neither on the plan's "relied on" list and neither used here (the same
 * "require only what's confirmed" posture `envelopeSchema`'s `result_info` takes; zod
 * drops undeclared fields without complaint, so leaving them out is enough to tolerate
 * them, not merely to make them optional).
 */
const tunnelConfigResultSchema = z.object({
  config: z.object({ ingress: z.array(ingressRuleSchema) }),
});

const dnsRecordSchema = z.object({ id: z.string() });
/** `name` is carried through so `findDnsRecord` can report "found nothing" without a
 * separate schema — the array can be empty, or contain records this client never reads
 * anything else off. */
const dnsRecordsResultSchema = z.array(dnsRecordSchema.extend({ name: z.string().optional() }));

const accessAppSchema = z.object({
  id: z.string(),
  aud: z.string(),
  domain: z.string().optional(),
});
const accessAppsResultSchema = z.array(accessAppSchema);

/**
 * The exact field name for a service token's secret on creation is one of the plan's
 * explicitly unverified facts. Modelled as two optional sibling fields on one flat object
 * — not a `z.union` of two alternate shapes the way `tunnelTokenResultSchema` is — because
 * the uncertainty here is a field NAME on an otherwise-identical object, not the
 * response's top-level TYPE (bare string vs wrapped object, `tunnelToken`'s case, where a
 * union is what lets zod tell the two shapes apart). `secretOf` below picks whichever
 * field is present and raises if neither is, or if it is empty — the secret is returned
 * once; an empty one is unrecoverable without rotation.
 */
const serviceTokenCreateResultSchema = z.object({
  id: z.string(),
  client_id: z.string(),
  client_secret: z.string().optional(),
  secret: z.string().optional(),
  expires_at: z.string().nullable().optional(),
});

/** Same secret-field ambiguity as creation, minus `id` — the rotate endpoint operates on
 * a token id this client already holds, and whether that id is echoed back was never
 * checked either way, so it is not required here. */
const rotateServiceTokenResultSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  secret: z.string().optional(),
  expires_at: z.string().nullable().optional(),
});

const serviceTokenListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  expires_at: z.string().nullable().optional(),
});
const serviceTokensListResultSchema = z.array(serviceTokenListItemSchema);

const policySchema = z.object({ id: z.string() });

/** Raises rather than resolving with `""` — see `serviceTokenCreateResultSchema`'s doc
 * comment for why this is two optional fields rather than a union, and `tunnelToken`
 * above for why an empty secret is treated as no secret at all. Never interpolates
 * whatever (possibly-empty) value it found into the thrown message: the message names
 * only the shape that was missing, never a value that could itself be a fragment of a
 * real secret. */
function secretOf(raw: { client_secret?: string; secret?: string }): string {
  const secret = raw.client_secret ?? raw.secret ?? "";
  if (secret.length === 0) {
    throw new CloudflareError(
      "cloudflare",
      "Cloudflare's service token response did not include a usable secret",
      { status: null, codes: [] },
    );
  }
  return secret;
}

export type CloudflareClient = {
  listZones(): Promise<Array<{ id: string; name: string }>>;
  /** Posts `config_src: "cloudflare"` — see the module-level note on `createTunnel`'s
   * implementation for why that field is the whole point. */
  createTunnel(name: string): Promise<{ id: string; name: string }>;
  /** Every tunnel on the account, deleted ones included (with `deletedAt` set) rather
   * than filtered out — a caller that wants only live tunnels filters on `deletedAt`
   * itself, and nothing here silently decides that for it. */
  listTunnels(): Promise<CloudflareTunnel[]>;
  /** Raises if Cloudflare's response has no usable, non-empty token — never resolves
   * with `""`. See `tunnelTokenResultSchema` above for why two shapes are accepted. */
  tunnelToken(tunnelId: string): Promise<string>;
  /** Idempotent: deleting a tunnel that is already deleted resolves, it does not throw.
   * The rollback path (2B's step-sequence runner) depends on that — rollback must be
   * safe to run twice. */
  deleteTunnel(tunnelId: string): Promise<void>;

  /** The tunnel's full ingress array — spec §6: "read tunnel config, splice `{ hostname,
   * service }` before the trailing catch-all, PUT it back." Always the whole array; there
   * is no add-one-rule endpoint (see `putTunnelConfig`). */
  getTunnelConfig(tunnelId: string): Promise<{ ingress: IngressRule[] }>;
  /** Replaces the tunnel's entire ingress array — there is no partial-update endpoint.
   * Callers (Task 3) are responsible for the mutex and the re-read-inside-the-lock
   * discipline §6 requires; this method has no opinion on concurrency, only on the wire
   * format of one PUT. */
  putTunnelConfig(tunnelId: string, config: { ingress: IngressRule[] }): Promise<void>;

  /** Always sends `type: "CNAME"` and `proxied: true` — see the method's own comment for
   * why an unproxied record is a silent failure nothing else would notice. */
  createDnsRecord(zoneId: string, r: { name: string; content: string }): Promise<{ id: string }>;
  /** Idempotent: deleting an already-absent record (a 404) resolves rather than throwing
   * — rollback and deprovisioning both depend on that. */
  deleteDnsRecord(zoneId: string, recordId: string): Promise<void>;
  /** `null` for no match, never a throw — the idempotency checks in Task 3/4 call this to
   * decide whether a record already exists before creating one. */
  findDnsRecord(zoneId: string, name: string): Promise<{ id: string } | null>;

  /** Always sends `type: "self_hosted"` and `policies` built from `policyIds`. See the
   * method's own comment on the one explicitly-unverified fact this touches: how a
   * reusable policy is attached. */
  createAccessApp(a: {
    domain: string;
    name: string;
    policyIds: string[];
  }): Promise<{ id: string; aud: string }>;
  /** Idempotent the same way `deleteDnsRecord` is. */
  deleteAccessApp(appId: string): Promise<void>;
  /** `null` for no match, never a throw. */
  findAccessApp(domain: string): Promise<{ id: string; aud: string } | null>;

  /** Raises if Cloudflare's response has no usable, non-empty secret — see
   * `secretOf`. */
  createServiceToken(
    name: string,
  ): Promise<{ id: string; clientId: string; clientSecret: string; expiresAt: number | null }>;
  /** A single dedicated `.../rotate` call — never a second call to read back
   * `client_secret_version`, which this client does not consume (neither `MonitorAccess`
   * nor anything downstream in this phase needs it; see the phase report). */
  rotateServiceToken(
    tokenId: string,
  ): Promise<{ clientId: string; clientSecret: string; expiresAt: number | null }>;
  /** Never carries a secret — Cloudflare's list endpoint does not return one, only
   * creation and rotation do. */
  listServiceTokens(): Promise<Array<{ id: string; name: string; expiresAt: number | null }>>;
  /** Not in the plan's original interface list. Added so `ensureMonitorAccess` (Task 2)
   * can compensate a service token whose paired policy creation failed — see this
   * method's test for the full justification. Idempotent like the other deletes here. */
  deleteServiceToken(tokenId: string): Promise<void>;

  /** Always sends `decision: "non_identity"` — anything else demands a human login, which
   * the monitor probe cannot give. See the method's own comment. */
  createMonitorPolicy(name: string, serviceTokenId: string): Promise<{ id: string }>;
};

/**
 * Maps a response's status and Cloudflare error codes to a `CloudflareFault`.
 *
 * Code `10000` ("Authentication error") is checked ahead of status, because Cloudflare
 * can carry it on a body that is not itself a 401 — the code is the more specific signal.
 * Everything else not otherwise recognised falls back to `cloudflare`: an API-reported
 * failure (or an unparseable body — see `runRequest`) whose cause is not one of the
 * classified cases is Cloudflare's problem to explain, not ours to invent a reason for.
 */
function classifyFault(status: number, codes: number[]): CloudflareFault {
  if (status === 401 || codes.includes(10000)) return "auth";
  if (status === 403) return "permission";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "cloudflare";
  if (status === 400) return "client";
  // Cloudflare does not always carry a permission failure on a genuine 403 — code 9109
  // ("Unauthorized to access requested resource") is documented to arrive on other
  // statuses too, a 200 with `success: false` among them. Falling through to the
  // `cloudflare` catch-all for that case would retry it three times and then print
  // "Cloudflare returned an unexpected error" about what is really a permission problem,
  // exactly the sentence the fault enum exists to avoid. Checked after every concrete
  // status match above, so an actual 401/403/429/5xx/400 keeps deciding on the status it
  // already has, the stronger signal for those.
  if (codes.includes(9109)) return "permission";
  return "cloudflare";
}

/**
 * `Retry-After` per RFC 9110: either an integer count of seconds, or an HTTP-date.
 * `nowMs` is injected (see `createCloudflareClient`) so the date form can be resolved
 * without a real clock in tests.
 */
function parseRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - nowMs);
}

function backoffMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

type PageResult = {
  zones: Array<{ id: string; name: string }>;
  resultInfo?: { page: number; per_page: number; total_count: number };
};

export function createCloudflareClient(opts: {
  token: string;
  accountId: string;
  fetch: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): CloudflareClient {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  /**
   * Strips the token out of anything that might become an `Error.message` (and therefore
   * `Error.stack`, which V8 builds from the message). A token in an error message ends up
   * in logs and in this project's audit trail, which records error text — see
   * `client.test.ts`'s "token never leaks" case.
   */
  function scrub(message: string): string {
    return opts.token.length > 0 ? message.split(opts.token).join("<redacted>") : message;
  }

  /**
   * The one request path every method on this client goes through — envelope parsing,
   * fault classification, bounded retry and token scrubbing all live here exactly once.
   * `listZones`'s pagination loop and the tunnel methods below both call this rather than
   * each re-implementing (or half-reimplementing) the retry loop; see the plan's note on
   * why a second request path is the thing to avoid.
   *
   * Takes a full URL rather than a path so callers decide their own base (`/zones` has no
   * account segment; the tunnel endpoints are all under `/accounts/{account_id}/...`) —
   * this function has no opinion on that, only on what happens once a request is sent.
   */
  async function requestEnvelope(req: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    body?: unknown;
  }): Promise<{
    result: unknown;
    resultInfo?: { page: number; per_page: number; total_count: number };
    status: number;
  }> {
    let lastFault: CloudflareFault = "network";
    let lastMessage = "the Cloudflare API request failed";
    let lastStatus: number | null = null;
    let lastCodes: number[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await opts.fetch(req.url, {
          method: req.method,
          headers: {
            authorization: `Bearer ${opts.token}`,
            accept: "application/json",
            ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        });
      } catch (error) {
        lastFault = "network";
        lastMessage = scrub(
          error instanceof Error ? error.message : "the Cloudflare API request failed",
        );
        lastStatus = null;
        lastCodes = [];
        // Reads `RETRYABLE_FAULTS` the same way the parsed-envelope branch below does —
        // see that set's doc comment. Before this fix, a transport failure was retried
        // unconditionally regardless of what the set said, which made `"network"`'s
        // membership decorative: deleting it from the set changed nothing here.
        if (attempt < MAX_ATTEMPTS && RETRYABLE_FAULTS.has(lastFault)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new CloudflareError(lastFault, lastMessage, { status: lastStatus, codes: lastCodes });
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      const parsed = envelopeSchema.safeParse(body);
      if (!parsed.success || !parsed.data.success) {
        const codes = parsed.success ? parsed.data.errors.map((e) => e.code) : [];
        const fault = classifyFault(response.status, codes);
        const firstError = parsed.success ? parsed.data.errors[0] : undefined;
        const message = firstError
          ? scrub(firstError.message)
          : // Not the v4 envelope at all — HTML from a proxy, an empty body. Phase 1F
            // shipped a defect of exactly this shape: a malformed 200 body overwrote a
            // real verdict with `undefined`. Raising here instead of returning
            // `undefined` as if it were zones is the fix that generalises.
            `Cloudflare's response did not match the expected shape (status ${response.status})`;

        lastFault = fault;
        lastMessage = message;
        lastStatus = response.status;
        lastCodes = codes;

        if (attempt < MAX_ATTEMPTS && RETRYABLE_FAULTS.has(fault)) {
          const retryAfter =
            fault === "rate_limit"
              ? parseRetryAfterMs(response.headers.get("retry-after"), now())
              : null;
          await sleep(retryAfter ?? backoffMs(attempt));
          continue;
        }
        throw new CloudflareError(fault, message, { status: lastStatus, codes: lastCodes });
      }

      return {
        result: parsed.data.result,
        resultInfo: parsed.data.result_info,
        status: response.status,
      };
    }

    // Unreachable in practice (the loop always returns or throws), but keeps the
    // function's return type honest without a non-null assertion.
    throw new CloudflareError(lastFault, lastMessage, { status: lastStatus, codes: lastCodes });
  }

  /** Every account-scoped endpoint (tunnels, and Access resources later) lives under this
   * prefix. `accountId` was accepted and stored by this client from the start for exactly
   * these — see the constructor options — but the zones call above deliberately never
   * sends it: whether `GET /zones` even accepts an account filter was never verified, and
   * a Zone:Read token's own scope already limits what it can see. */
  function accountUrl(path: string): string {
    return `${API_BASE}/accounts/${opts.accountId}${path}`;
  }

  /** DNS and (later) other zone-scoped resources live under this prefix, parallel to
   * `accountUrl` above — `zoneId` is per-call rather than a constructor option because,
   * unlike the account, a caller may work against different zones from one client. */
  function zoneUrl(zoneId: string, path: string): string {
    return `${API_BASE}/zones/${zoneId}${path}`;
  }

  /**
   * `DELETE` a resource, treating a 404 as success rather than an error. Shared by every
   * delete method below (DNS records, Access apps, service tokens) rather than each
   * re-implementing it — the same "one path, not several" reasoning `requestEnvelope`
   * itself is built on.
   *
   * Unlike `deleteTunnel`'s documented assumption (tunnels are soft-deleted, so a repeat
   * delete is assumed to report the same `success: true` envelope), these resources are
   * hard-deleted: a second delete genuinely has nothing left to remove, and Cloudflare's
   * own REST convention for "no resource at this id" is a 404. That convention is not on
   * the plan's "relied on" list by name, but it is ordinary HTTP semantics for an
   * id-addressed path (`/{resource}/{id}`), not a Cloudflare-specific guess the way the
   * three flagged facts are — and every test here defines its own fixture's status code,
   * so nothing depends on that guess being right against the real API today, only on this
   * client's own contract being consistent.
   */
  async function deleteIdempotently(req: { method: "DELETE"; url: string }): Promise<void> {
    try {
      await requestEnvelope(req);
    } catch (error) {
      if (error instanceof CloudflareError && error.status === 404) return;
      throw error;
    }
  }

  /** One page of `GET /zones`, with retry — the only thing specific to zones is the URL
   * and the result's shape; `requestEnvelope` does the rest. */
  async function requestPage(page: number): Promise<PageResult> {
    const { result, resultInfo } = await requestEnvelope({
      method: "GET",
      url: `${API_BASE}/zones?page=${page}`,
    });
    const zonesParsed = zonesResultSchema.safeParse(result);
    if (!zonesParsed.success) {
      throw new CloudflareError(
        "cloudflare",
        "Cloudflare's zones response did not match the expected shape",
        { status: null, codes: [] },
      );
    }
    return { zones: zonesParsed.data, resultInfo };
  }

  return {
    async listZones() {
      const zones: Array<{ id: string; name: string }> = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { zones: pageZones, resultInfo } = await requestPage(page);
        zones.push(...pageZones);
        if (!resultInfo || pageZones.length === 0) return zones;
        // Compared against `page` — the page WE just requested — not `resultInfo.page`
        // echoed back by the server. An API that ignores `?page=` and always answers
        // page 1 would otherwise convince this loop it is perpetually on page 1: `fetched`
        // would never grow, the break below would never fire, and there was previously no
        // other bound — measured at 203 requests and still climbing. `page` always
        // advances regardless of what the response claims, so the `MAX_PAGES` bound below
        // is what actually stops it.
        const fetched = page * resultInfo.per_page;
        if (fetched >= resultInfo.total_count) return zones;
      }
      // Exceeding the cap raises, rather than returning the zones gathered so far: a
      // partial list would let an admin pick a zone that exists while a later sub-phase,
      // querying by name, cannot find it — a silent truncation is worse than a clear
      // failure here.
      throw new CloudflareError(
        "cloudflare",
        `Cloudflare's zones listing did not complete within ${MAX_PAGES} pages; the API may be ignoring pagination`,
        { status: null, codes: [] },
      );
    },

    /**
     * `config_src: "cloudflare"` on the request body is the entire point of this method
     * (see the plan's §6 and the commit this ships in) — it is what keeps ingress
     * decisions in Cloudflare's API rather than a local config file cloudflared would
     * need restarting to reread. Nothing in this client's response handling would notice
     * if it were dropped from the body, which is exactly why `client.test.ts` asserts on
     * the outgoing request rather than the parsed response.
     */
    async createTunnel(name) {
      const { result } = await requestEnvelope({
        method: "POST",
        url: accountUrl("/cfd_tunnel"),
        body: { name, config_src: "cloudflare" },
      });
      const parsed = tunnelSchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's tunnel response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      return { id: parsed.data.id, name: parsed.data.name };
    },

    async listTunnels() {
      const { result } = await requestEnvelope({ method: "GET", url: accountUrl("/cfd_tunnel") });
      const parsed = tunnelsResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's tunnel list response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      return parsed.data.map(toTunnel);
    },

    async tunnelToken(tunnelId) {
      const { result } = await requestEnvelope({
        method: "GET",
        url: accountUrl(`/cfd_tunnel/${tunnelId}/token`),
      });
      const parsed = tunnelTokenResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's tunnel token response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      const token = typeof parsed.data === "string" ? parsed.data : parsed.data.token;
      // A missing or empty token is exactly the "success with no version in it" failure
      // this project has already shipped once (Phase 1G, a missing Docker version field).
      // Raising here — never returning `""` — is the fix that generalises: an empty
      // string in a `.env` produces a container that starts, fails to connect, and looks
      // like a network problem to whoever debugs it next.
      if (token.length === 0) {
        throw new CloudflareError("cloudflare", "Cloudflare returned an empty tunnel token", {
          status: null,
          codes: [],
        });
      }
      return token;
    },

    /**
     * Idempotent by design, not by special-casing a response shape: Cloudflare tunnels
     * are soft-deleted (see `tunnelSchema`'s `deleted_at`), so re-deleting an
     * already-deleted tunnel is ASSUMED to report the same `success: true` envelope as
     * the first call — this is unverified, one of the plan's explicitly-unverified facts
     * (like the active-connections question in the next paragraph), not a confirmed
     * Cloudflare guarantee. If Cloudflare instead returns a 404 or an error code, every
     * rollback that re-enters `deleteTunnel` turns a clean unwind into a spurious MANUAL
     * CLEANUP banner — worth knowing before leaning on this harder. This method does not
     * add its own "already deleted" precondition check on top of that assumption — such a
     * check is exactly what would make a repeat call throw, which is the failure
     * `client.test.ts`'s idempotency test binds against.
     *
     * Whether Cloudflare instead refuses a delete while the tunnel has active connections
     * is the plan's second explicitly-unverified fact. This method does not guess at a
     * `?cascade=` flag or similar to force it through: if that refusal exists, it already
     * arrives as an ordinary non-success envelope and surfaces as a normal
     * `CloudflareError`, fault-classified the same as any other rejected request — failing
     * loudly rather than silently swallowing a real refusal.
     */
    async deleteTunnel(tunnelId) {
      await requestEnvelope({ method: "DELETE", url: accountUrl(`/cfd_tunnel/${tunnelId}`) });
    },

    async getTunnelConfig(tunnelId) {
      const { result } = await requestEnvelope({
        method: "GET",
        url: accountUrl(`/cfd_tunnel/${tunnelId}/configurations`),
      });
      const parsed = tunnelConfigResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's tunnel configuration response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      return { ingress: parsed.data.config.ingress };
    },

    async putTunnelConfig(tunnelId, config) {
      await requestEnvelope({
        method: "PUT",
        url: accountUrl(`/cfd_tunnel/${tunnelId}/configurations`),
        body: { config: { ingress: config.ingress } },
      });
    },

    /**
     * `type: "CNAME"` and `proxied: true` on the request body are the entire point of
     * this method (see the plan and `client.test.ts`'s binding test) — an unproxied
     * record points at a hostname that never resolves publicly, and nothing else in the
     * system would notice: the DNS record would exist, the Access application would
     * exist, and only an external visitor would ever see the failure.
     */
    async createDnsRecord(zoneId, r) {
      const { result } = await requestEnvelope({
        method: "POST",
        url: zoneUrl(zoneId, "/dns_records"),
        body: { type: "CNAME", name: r.name, content: r.content, proxied: true },
      });
      const parsed = dnsRecordSchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's DNS record response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      return { id: parsed.data.id };
    },

    async deleteDnsRecord(zoneId, recordId) {
      await deleteIdempotently({
        method: "DELETE",
        url: zoneUrl(zoneId, `/dns_records/${recordId}`),
      });
    },

    async findDnsRecord(zoneId, name) {
      const { result } = await requestEnvelope({
        method: "GET",
        url: `${zoneUrl(zoneId, "/dns_records")}?name=${encodeURIComponent(name)}`,
      });
      const parsed = dnsRecordsResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's DNS record list response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      const [first] = parsed.data;
      return first ? { id: first.id } : null;
    },

    /**
     * `type: "self_hosted"` on the request body is the other binding assertion this
     * batch carries (alongside `createDnsRecord`'s `proxied: true`) — see the plan.
     *
     * How a reusable policy attaches to an application is one of the plan's three
     * explicitly-unverified facts. This sends `policies` as an array of `{ id }` objects
     * — the shape §6 itself states ("attached to every provisioned app as `{ "id": "..."
     * }`") — embedded directly in the app-creation body, rather than creating the app
     * first and calling a separate attach endpoint after. It does not guess at BOTH
     * shapes, because unlike a response (where accepting two shapes costs nothing), a
     * request can only be sent one way — sending it twice, to both a body field and a
     * hypothetical separate endpoint, risks a duplicate attachment rather than resolving
     * the ambiguity. If this shape is wrong, Cloudflare rejects the malformed body with a
     * non-success envelope, which `requestEnvelope` already turns into a normal
     * `CloudflareError` (`client` or `cloudflare` fault) — a loud, legible failure, not a
     * silent one. See the phase report for this call.
     */
    async createAccessApp(a) {
      const { result } = await requestEnvelope({
        method: "POST",
        url: accountUrl("/access/apps"),
        body: {
          name: a.name,
          domain: a.domain,
          type: "self_hosted",
          policies: a.policyIds.map((id) => ({ id })),
        },
      });
      const parsed = accessAppSchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's Access application response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      return { id: parsed.data.id, aud: parsed.data.aud };
    },

    async deleteAccessApp(appId) {
      await deleteIdempotently({ method: "DELETE", url: accountUrl(`/access/apps/${appId}`) });
    },

    /**
     * Lists every Access application and matches by `domain` client-side, rather than
     * relying on a query-parameter filter — whether the list endpoint even supports one
     * was never checked, and this project would rather make one extra round trip (Access
     * applications on a single-NAS account are few) than depend on an unverified filter
     * silently matching nothing and reading as "no such app" when the API just ignored
     * the parameter.
     */
    async findAccessApp(domain) {
      const { result } = await requestEnvelope({ method: "GET", url: accountUrl("/access/apps") });
      const parsed = accessAppsResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's Access application list response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      const match = parsed.data.find((app) => app.domain === domain);
      return match ? { id: match.id, aud: match.aud } : null;
    },

    async createServiceToken(name) {
      const { result } = await requestEnvelope({
        method: "POST",
        url: accountUrl("/access/service_tokens"),
        body: { name },
      });
      const parsed = serviceTokenCreateResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's service token response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      return {
        id: parsed.data.id,
        clientId: parsed.data.client_id,
        clientSecret: secretOf(parsed.data),
        expiresAt: parseIsoOrNull(parsed.data.expires_at, "expires_at"),
      };
    },

    async rotateServiceToken(tokenId) {
      const { result } = await requestEnvelope({
        method: "POST",
        url: accountUrl(`/access/service_tokens/${tokenId}/rotate`),
      });
      const parsed = rotateServiceTokenResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's service token rotation response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      return {
        clientId: parsed.data.client_id,
        clientSecret: secretOf(parsed.data),
        expiresAt: parseIsoOrNull(parsed.data.expires_at, "expires_at"),
      };
    },

    async listServiceTokens() {
      const { result } = await requestEnvelope({
        method: "GET",
        url: accountUrl("/access/service_tokens"),
      });
      const parsed = serviceTokensListResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's service token list response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      return parsed.data.map((t) => ({
        id: t.id,
        name: t.name,
        expiresAt: parseIsoOrNull(t.expires_at, "expires_at"),
      }));
    },

    async deleteServiceToken(tokenId) {
      await deleteIdempotently({
        method: "DELETE",
        url: accountUrl(`/access/service_tokens/${tokenId}`),
      });
    },

    /**
     * `decision: "non_identity"` on the request body is the binding assertion — a policy
     * that instead demands identity verification requires a human login, which the
     * monitor probe (2E) cannot give. The failure mode this guards against is not an
     * obvious misconfiguration: every external probe would simply get redirected to a
     * login page and read as "down" or "degraded" rather than "policy misconfigured".
     */
    async createMonitorPolicy(name, serviceTokenId) {
      const { result } = await requestEnvelope({
        method: "POST",
        url: accountUrl("/access/policies"),
        body: {
          name,
          decision: "non_identity",
          include: [{ service_token: { token_id: serviceTokenId } }],
        },
      });
      const parsed = policySchema.safeParse(result);
      if (!parsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's Access policy response did not match the expected shape",
          { status: null, codes: [] },
        );
      }
      return { id: parsed.data.id };
    },
  };
}
