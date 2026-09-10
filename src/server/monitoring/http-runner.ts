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

async function sampleBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, BODY_SAMPLE_BYTES);
  } catch {
    return "";
  }
}

export function createHttpRunners(deps: {
  fetch: typeof fetch;
  accessCredentials?: () => Promise<AccessCredentials | null>;
}): { internal: ProbeRunner; external: ProbeRunner } {
  async function request(
    probe: ProbeRow,
    headers: Record<string, string>,
  ): Promise<{ response: Response; latencyMs: number } | { failure: ProbeResult }> {
    if (!probe.target) {
      return { failure: { status: "down", faultClass: "config", detail: { error: "no target" } } };
    }
    try {
      new URL(probe.target);
    } catch {
      return {
        failure: { status: "down", faultClass: "config", detail: { error: "target is not a URL" } },
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
      const credentials = (await deps.accessCredentials?.()) ?? null;
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
