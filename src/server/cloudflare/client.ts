import { z } from "zod";
import { CloudflareError, type CloudflareFault } from "./errors.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

/** Bounded so a struggling API gets a handful of attempts, not an unbounded hammer:
 * the original call plus two retries. */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

/**
 * Which faults are worth retrying, and why the rest are not.
 *
 * `rate_limit` and `cloudflare` (Cloudflare's own 5xx, or a body that isn't the v4
 * envelope at all — a proxy or edge hiccup) are transient: the same request against the
 * same token can succeed a few seconds later. `network` — `fetch` never reaching
 * Cloudflare — is exactly as transient. `auth` and `permission` are properties of the
 * TOKEN, not the moment: an expired token or a scope it never had is still expired or
 * missing on the next attempt, and retrying it three times only delays the message an
 * admin needs to act on. `client` means the request WE sent was malformed; Cloudflare
 * will reject the identical retry the same way.
 */
const RETRYABLE_FAULTS: ReadonlySet<CloudflareFault> = new Set([
  "rate_limit",
  "cloudflare",
  "network",
]);

const errorSchema = z.object({ code: z.number(), message: z.string() });

const envelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(errorSchema).default([]),
  result: z.unknown().optional(),
  result_info: z
    .object({
      page: z.number(),
      per_page: z.number(),
      count: z.number(),
      total_count: z.number(),
    })
    .optional(),
});

const zoneSchema = z.object({ id: z.string(), name: z.string() });
const zonesResultSchema = z.array(zoneSchema);

export type CloudflareClient = {
  listZones(): Promise<Array<{ id: string; name: string }>>;
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
  resultInfo?: { page: number; per_page: number; count: number; total_count: number };
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
   * One page of `GET /zones`, with retry.
   *
   * `accountId` is accepted by this client (and stored on it) for the account-scoped
   * endpoints later sub-phases add — tunnels and Access resources all live under
   * `/accounts/{account_id}/...`. It is deliberately NOT sent as a filter on this zones
   * call: whether `GET /zones` even accepts an account filter is not on this plan's list
   * of verified Cloudflare facts (see the plan's "what is known" section), and a
   * Zone:Read token's own scope already limits which zones it can see. Guessing a query
   * parameter into the one endpoint this phase can actually exercise would trade a real
   * verification for an invented one.
   */
  async function requestPage(page: number): Promise<PageResult> {
    let lastFault: CloudflareFault = "network";
    let lastMessage = "the Cloudflare API request failed";
    let lastStatus: number | null = null;
    let lastCodes: number[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await opts.fetch(`${API_BASE}/zones?page=${page}`, {
          method: "GET",
          headers: {
            authorization: `Bearer ${opts.token}`,
            accept: "application/json",
          },
        });
      } catch (error) {
        lastFault = "network";
        lastMessage = scrub(
          error instanceof Error ? error.message : "the Cloudflare API request failed",
        );
        lastStatus = null;
        lastCodes = [];
        if (attempt < MAX_ATTEMPTS) {
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

      const zonesParsed = zonesResultSchema.safeParse(parsed.data.result);
      if (!zonesParsed.success) {
        throw new CloudflareError(
          "cloudflare",
          "Cloudflare's zones response did not match the expected shape",
          { status: response.status, codes: [] },
        );
      }

      return { zones: zonesParsed.data, resultInfo: parsed.data.result_info };
    }

    // Unreachable in practice (the loop always returns or throws), but keeps the
    // function's return type honest without a non-null assertion.
    throw new CloudflareError(lastFault, lastMessage, { status: lastStatus, codes: lastCodes });
  }

  return {
    async listZones() {
      const zones: Array<{ id: string; name: string }> = [];
      let page = 1;
      for (;;) {
        const { zones: pageZones, resultInfo } = await requestPage(page);
        zones.push(...pageZones);
        if (!resultInfo || pageZones.length === 0) break;
        const fetched = resultInfo.page * resultInfo.per_page;
        if (fetched >= resultInfo.total_count) break;
        page += 1;
      }
      return zones;
    },
  };
}
