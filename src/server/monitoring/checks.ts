import { resolve } from "node:dns/promises";
import { Socket } from "node:net";
import type { MonitorType } from "@shared/monitoring.js";
import { z } from "zod";

export type CheckResult = {
  up: boolean;
  durationMs: number;
  error: string | null;
};

export type CheckContext = {
  now: () => number;
  /** Epoch ms of the last push for the monitor being checked, or null if none has arrived. */
  lastPushAt: () => number | null;
  /** The synced `connectedToControl` for a device, or null if unknown.
   *  The `tailscale` executor reads state the sync already fetched; it must
   *  not call the API itself, or one tick would issue a request per device. */
  deviceConnected: (deviceId: string) => boolean | null;
  /** Container state for a service. Returns null when there is no such container. */
  containerState: (
    projectSlug: string,
    service: string,
  ) => Promise<{
    state: string;
    health: string | null;
  } | null>;
  /** The Cloudflare Access service token the `reachability` executor presents,
   *  or null when Cloudflare has not been set up. Resolved once per tick for
   *  the same reason `deviceConnected` is: reading it per monitor would mean
   *  one decrypt per published app, every interval. */
  accessServiceToken: () => { clientId: string; clientSecret: string } | null;
};

export type CheckExecutor = (
  config: unknown,
  timeoutMs: number,
  ctx: CheckContext,
) => Promise<CheckResult>;

const pushConfigSchema = z.object({
  graceSeconds: z.number(),
  intervalSeconds: z.number().optional(),
});

const tailscaleConfigSchema = z.object({
  deviceId: z.string(),
});

const tcpConfigSchema = z.object({
  host: z.string(),
  port: z.number(),
});

const httpConfigSchema = z.object({
  url: z.string(),
});

const dnsConfigSchema = z.object({
  hostname: z.string(),
});

/**
 * Only the URL. The Access service token arrives through {@link CheckContext},
 * not through here: a credential copied into every monitor's config row would
 * have to be rewritten on every rotation, and would put the plaintext secret
 * in as many rows as there are published apps instead of one.
 */
const reachabilityConfigSchema = z.object({
  url: z.string(),
});

const dockerConfigSchema = z.object({
  projectSlug: z.string(),
  service: z.string(),
});

/**
 * The config contract each executor validates, keyed by monitor type.
 *
 * Exported so a producer of monitor config can be checked against the consumer
 * without running the executor — which would mean real network I/O in a unit
 * test. `desiredMonitors` emitted a tcp config with no `host` and a
 * reachability config shaped for an entirely different schema; both sides had
 * tests, neither test crossed the seam, and every app tile read "down" for the
 * validation error rather than for anything about the app.
 */
export const configSchemas: Record<MonitorType, z.ZodType> = {
  push: pushConfigSchema,
  tailscale: tailscaleConfigSchema,
  tcp: tcpConfigSchema,
  http: httpConfigSchema,
  dns: dnsConfigSchema,
  reachability: reachabilityConfigSchema,
  docker: dockerConfigSchema,
};

async function pushExecutor(
  config: unknown,
  _timeoutMs: number,
  ctx: CheckContext,
): Promise<CheckResult> {
  const start = performance.now();
  const parsed = pushConfigSchema.safeParse(config);

  if (!parsed.success) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: `Invalid config: ${parsed.error.message}`,
    };
  }

  const { graceSeconds, intervalSeconds = 0 } = parsed.data;
  const lastPush = ctx.lastPushAt();

  if (lastPush === null) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: "Never received a push callback",
    };
  }

  const now = ctx.now();
  const deadlineMs = (intervalSeconds + graceSeconds) * 1000;
  const elapsed = now - lastPush;

  if (elapsed > deadlineMs) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: `Last push was ${Math.floor(elapsed / 1000)}s ago, deadline is ${Math.floor(deadlineMs / 1000)}s`,
    };
  }

  return {
    up: true,
    durationMs: performance.now() - start,
    error: null,
  };
}

async function tailscaleExecutor(
  config: unknown,
  _timeoutMs: number,
  ctx: CheckContext,
): Promise<CheckResult> {
  const start = performance.now();
  const parsed = tailscaleConfigSchema.safeParse(config);

  if (!parsed.success) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: `Invalid config: ${parsed.error.message}`,
    };
  }

  const { deviceId } = parsed.data;
  const connected = ctx.deviceConnected(deviceId);

  if (connected === null) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: "Device has not synced yet",
    };
  }

  return {
    up: connected,
    durationMs: performance.now() - start,
    error: connected ? null : "Device is disconnected from control plane",
  };
}

async function tcpExecutor(
  config: unknown,
  timeoutMs: number,
  _ctx: CheckContext,
): Promise<CheckResult> {
  const start = performance.now();
  const parsed = tcpConfigSchema.safeParse(config);

  if (!parsed.success) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: `Invalid config: ${parsed.error.message}`,
    };
  }

  const { host, port } = parsed.data;

  return new Promise((resolve) => {
    const socket = new Socket();
    let finished = false;

    const finish = (result: CheckResult) => {
      if (finished) return;
      finished = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.on("connect", () => {
      finish({
        up: true,
        durationMs: performance.now() - start,
        error: null,
      });
    });

    socket.on("error", (err) => {
      finish({
        up: false,
        durationMs: performance.now() - start,
        error: err.message,
      });
    });

    socket.on("timeout", () => {
      finish({
        up: false,
        durationMs: performance.now() - start,
        error: "Connection timeout",
      });
    });

    socket.connect(port, host);
  });
}

async function httpExecutor(
  config: unknown,
  timeoutMs: number,
  _ctx: CheckContext,
): Promise<CheckResult> {
  const start = performance.now();
  const parsed = httpConfigSchema.safeParse(config);

  if (!parsed.success) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: `Invalid config: ${parsed.error.message}`,
    };
  }

  const { url } = parsed.data;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 2xx is up, but also 401 and 403: an app behind a login is responding,
    // just with an auth challenge. Marking those as down produces false-red
    // tiles for healthy apps that require authentication.
    if (response.ok || response.status === 401 || response.status === 403) {
      return {
        up: true,
        durationMs: performance.now() - start,
        error: null,
      };
    }

    return {
      up: false,
      durationMs: performance.now() - start,
      error: `HTTP ${response.status}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout =
      message.includes("TimeoutError") || message.includes("aborted");

    return {
      up: false,
      durationMs: performance.now() - start,
      error: isTimeout ? "Request timeout" : message,
    };
  }
}

async function dnsExecutor(
  config: unknown,
  timeoutMs: number,
  _ctx: CheckContext,
): Promise<CheckResult> {
  const start = performance.now();
  const parsed = dnsConfigSchema.safeParse(config);

  if (!parsed.success) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: `Invalid config: ${parsed.error.message}`,
    };
  }

  const { hostname } = parsed.data;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("DNS timeout")), timeoutMs);
    });

    await Promise.race([resolve(hostname), timeoutPromise]);

    return {
      up: true,
      durationMs: performance.now() - start,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes("timeout");

    return {
      up: false,
      durationMs: performance.now() - start,
      error: isTimeout ? "DNS timeout" : message,
    };
  }
}

async function reachabilityExecutor(
  config: unknown,
  timeoutMs: number,
  ctx: CheckContext,
): Promise<CheckResult> {
  const start = performance.now();
  const parsed = reachabilityConfigSchema.safeParse(config);

  if (!parsed.success) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: `Invalid config: ${parsed.error.message}`,
    };
  }

  const { url } = parsed.data;

  // No token means Cloudflare was never set up, which is a configuration
  // state rather than an outage. Reported as down because a published app we
  // cannot probe is not something to call green, but with a message that
  // sends the reader to the setup screen instead of to the app's logs.
  const token = ctx.accessServiceToken();
  if (!token) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: "No Access service token — finish Cloudflare setup",
    };
  }
  const { clientId, clientSecret } = token;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
      headers: {
        "CF-Access-Client-Id": clientId,
        "CF-Access-Client-Secret": clientSecret,
      },
    });

    // 2xx is up
    if (response.ok) {
      return {
        up: true,
        durationMs: performance.now() - start,
        error: null,
      };
    }

    // 3xx redirect to cloudflareaccess.com means Access rejected the token
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "";
      try {
        const locationUrl = new URL(location);
        if (
          locationUrl.host === "cloudflareaccess.com" ||
          locationUrl.host.endsWith(".cloudflareaccess.com")
        ) {
          return {
            up: false,
            durationMs: performance.now() - start,
            error: "access: Authentication failed",
          };
        }
      } catch {
        // Invalid location URL, fall through to default handling
      }
    }

    return {
      up: false,
      durationMs: performance.now() - start,
      error: `HTTP ${response.status}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout =
      message.includes("TimeoutError") || message.includes("aborted");

    // Never include the client secret in error messages
    const sanitizedMessage = message.replace(clientSecret, "***");

    return {
      up: false,
      durationMs: performance.now() - start,
      error: isTimeout ? "Request timeout" : sanitizedMessage,
    };
  }
}

async function dockerExecutor(
  config: unknown,
  _timeoutMs: number,
  ctx: CheckContext,
): Promise<CheckResult> {
  const start = performance.now();
  const parsed = dockerConfigSchema.safeParse(config);

  if (!parsed.success) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: `Invalid config: ${parsed.error.message}`,
    };
  }

  const { projectSlug, service } = parsed.data;
  const containerInfo = await ctx.containerState(projectSlug, service);

  if (containerInfo === null) {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: "Container not found",
    };
  }

  const { state, health } = containerInfo;

  // Down if restarting
  if (state === "restarting") {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: "Container is restarting",
    };
  }

  // Down if not running
  if (state !== "running") {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: `Container is ${state}`,
    };
  }

  // Running but unhealthy
  if (health === "unhealthy") {
    return {
      up: false,
      durationMs: performance.now() - start,
      error: "Container is unhealthy",
    };
  }

  // Running and either healthy or no healthcheck
  return {
    up: true,
    durationMs: performance.now() - start,
    error: null,
  };
}

export const executors: Record<MonitorType, CheckExecutor> = {
  push: pushExecutor,
  tailscale: tailscaleExecutor,
  tcp: tcpExecutor,
  http: httpExecutor,
  dns: dnsExecutor,
  reachability: reachabilityExecutor,
  docker: dockerExecutor,
};
