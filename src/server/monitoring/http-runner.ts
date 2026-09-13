import { matchesStatusPattern } from "./status-pattern.js";
import type { ProbeContext, ProbeResult, ProbeRow, ProbeRunner } from "./types.js";

/** Enough of the body to recognise a Cloudflare error page, and no more. */
const BODY_SAMPLE_BYTES = 2048;

type AccessCredentials = { clientId: string; clientSecret: string };

function classifyThrown(error: unknown): ProbeResult {
  const message = error instanceof Error ? error.message : String(error);
  // DNS is a configuration mistake — a hostname that does not exist. A refused
  // connection or a timeout is the network. The distinction is the whole point of
  // faultClass: it decides whether the UI says "check the address" or "the tunnel is down".
  const isDns = /ENOTFOUND|EAI_AGAIN/i.test(message);
  const isTimeout = /abort|timeout/i.test(message);
  return {
    status: "down",
    faultClass: isDns ? "config" : "network",
    detail: { error: isTimeout ? "timed out" : isDns ? "host does not resolve" : "unreachable" },
  };
}

/**
 * Reads at most `BODY_SAMPLE_BYTES` and then stops the transfer.
 *
 * `response.text()` would buffer the WHOLE body before slicing, so an origin behind the
 * tunnel that answers a 5xx with a gigabyte would be read in full — every 60 seconds,
 * for the life of the probe. Streaming and cancelling bounds what crosses the wire, not
 * just what we keep.
 */
async function sampleBody(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < BODY_SAMPLE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch {
    // A truncated or broken body is not worth failing the classification over.
  } finally {
    // Stops the transfer rather than merely ignoring the rest of it.
    await reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Decode everything we read, deliberately WITHOUT slicing to the cap.
  //
  // The loop already stopped once `total` reached the cap, so memory is bounded by the
  // cap plus one chunk either way — the slice bounded nothing extra. What it did do was
  // cut a marker that straddled the boundary: a body of 2047 filler bytes followed by
  // "1033" decoded as "…1", `includes('1033')` failed, and a tunnel outage was reported
  // as an application fault.
  return new TextDecoder().decode(joined);
}

export function createHttpRunners(deps: {
  fetch: typeof fetch;
  // Required, not optional. This is the exact call-site defect Phase 1 shipped with:
  // an omitted argument that type-checked and left every `http_external` probe
  // reporting `degraded` forever. A caller with genuinely no store must say so
  // explicitly with `() => Promise.resolve(null)` — see `build-runners.ts`'s doc
  // comment for why a test alone was not enough to keep this closed.
  accessCredentials: () => Promise<AccessCredentials | null>;
}): { internal: ProbeRunner; external: ProbeRunner } {
  async function request(
    probe: ProbeRow,
    headers: Record<string, string>,
  ): Promise<{ response: Response; latencyMs: number } | { failure: ProbeResult }> {
    if (!probe.target) {
      return { failure: { status: "down", faultClass: "config", detail: { error: "no target" } } };
    }
    // Scheme-check here as well as at the API. The probe API rejects a non-http(s) target
    // when the user types it, but this is the code that actually makes the request, and a
    // row can reach it by other routes — a migration, an import, a direct database edit.
    // The component that performs the fetch is the right place to refuse a scheme it
    // should never fetch.
    let parsed: URL;
    try {
      parsed = new URL(probe.target);
    } catch {
      return {
        failure: { status: "down", faultClass: "config", detail: { error: "target is not a URL" } },
      };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        failure: {
          status: "down",
          faultClass: "config",
          detail: { error: "target must be http or https" },
        },
      };
    }

    const startedAt = Date.now();
    try {
      const response = await deps.fetch(probe.target, {
        method: "GET",
        headers,
        // Load-bearing. Access rejects by redirecting to a login page that returns 200,
        // so a monitor that follows redirects reports a dead origin as healthy forever.
        redirect: "manual",
        signal: AbortSignal.timeout(probe.timeoutMs),
      });
      return { response, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { failure: classifyThrown(error) };
    }
  }

  const internal: ProbeRunner = {
    kind: "http_internal",
    // The default pattern accepts 3xx, which the spec specifies. That is right here and
    // not the blind spot the external classification exists to close: an app redirecting
    // to its own login page is reachable, which is all an internal probe asks. Access
    // redirecting to *its* login page is an interception by something that is not the
    // app, which is why only the external runner inspects the destination.
    async run(probe: ProbeRow, _ctx: ProbeContext): Promise<ProbeResult> {
      const attempt = await request(probe, {});
      if ("failure" in attempt) return attempt.failure;

      const { response, latencyMs } = attempt;
      const ok = matchesStatusPattern(probe.expectedStatusPattern, response.status);
      return {
        status: ok ? "up" : "down",
        latencyMs,
        ...(ok ? {} : { faultClass: "app" as const }),
        detail: { status: response.status },
      };
    },
  };

  const external: ProbeRunner = {
    kind: "http_external",
    async run(probe: ProbeRow, _ctx: ProbeContext): Promise<ProbeResult> {
      const credentials = (await deps.accessCredentials()) ?? null;
      if (!credentials) {
        // Every request would land on the login page. "Up" would be a lie and "down"
        // would blame the app for a missing service token.
        return {
          status: "degraded",
          faultClass: "config",
          detail: { error: "no Access service token configured" },
        };
      }

      const attempt = await request(probe, {
        "cf-access-client-id": credentials.clientId,
        "cf-access-client-secret": credentials.clientSecret,
      });
      if ("failure" in attempt) return attempt.failure;

      const { response, latencyMs } = attempt;
      const location = response.headers.get("location") ?? "";

      if (/\.cloudflareaccess\.com/i.test(location)) {
        return {
          status: "degraded",
          faultClass: "config",
          latencyMs,
          detail: { status: response.status, error: "Access rejected the service token" },
        };
      }

      if (response.status === 502 || response.status === 503) {
        return {
          status: "down",
          faultClass: "network",
          latencyMs,
          detail: { status: response.status, error: "tunnel or origin unreachable" },
        };
      }

      // Cloudflare reports tunnel failures as a 1033 in the body, sometimes under a 530.
      if (response.status >= 500) {
        const body = await sampleBody(response);
        if (body.includes("1033")) {
          return {
            status: "down",
            faultClass: "network",
            latencyMs,
            detail: { status: response.status, error: "Argo Tunnel error 1033" },
          };
        }
        return {
          status: "down",
          faultClass: "app",
          latencyMs,
          detail: { status: response.status },
        };
      }

      const ok = matchesStatusPattern(probe.expectedStatusPattern, response.status);
      return {
        status: ok ? "up" : "down",
        latencyMs,
        ...(ok ? {} : { faultClass: "app" as const }),
        detail: { status: response.status },
      };
    },
  };

  return { internal, external };
}
