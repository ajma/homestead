import type { CloudflareFault } from "@shared/cloudflare.js";

export type { CloudflareFault };

/**
 * Cloudflare's failure classified into the sentence a caller needs to say about it.
 *
 * A raw HTTP status is not enough on its own: Cloudflare answers a failed request with
 * HTTP 200 and `success: false` as often as with a real 4xx/5xx (see `client.ts`), so the
 * fault is derived from the parsed envelope, not just `response.status`. An expired token,
 * a missing permission and a rate limit are three different things to tell an admin, and
 * only one of them (`rate_limit`) is worth waiting out.
 */
export class CloudflareError extends Error {
  readonly fault: CloudflareFault;
  readonly status: number | null;
  readonly codes: number[];

  constructor(
    fault: CloudflareFault,
    message: string,
    opts: { status?: number | null; codes?: number[] } = {},
  ) {
    super(message);
    this.name = "CloudflareError";
    this.fault = fault;
    this.status = opts.status ?? null;
    this.codes = opts.codes ?? [];
  }
}
