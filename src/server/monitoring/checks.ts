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

    if (response.ok) {
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

export const executors: Record<MonitorType, CheckExecutor> = {
  push: pushExecutor,
  tailscale: tailscaleExecutor,
  tcp: tcpExecutor,
  http: httpExecutor,
  dns: dnsExecutor,
};
