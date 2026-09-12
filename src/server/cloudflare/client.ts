import type { CloudflareFault } from "@shared/cloudflare.js";
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
        // Reads `RETRYABLE_FAULTS` the same way the parsed-envelope branch below does —
        // see that set's doc comment. Before this fix, a transport failure was retried
        // unconditionally regardless of what the set said, which made `"network"`'s
        // membership decorative: deleting it from the set changed nothing here.
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
  };
}
