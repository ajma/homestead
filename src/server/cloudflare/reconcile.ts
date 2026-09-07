import { createHash } from "node:crypto";
import type { IngressRule } from "./tunnel.js";

export type ExposureRow = {
  hostname: string;
  hostPort: number;
  scheme: "http" | "https";
  noTlsVerify: boolean;
  enabled: boolean;
};

export function desiredIngress(rows: ExposureRow[]): IngressRule[] {
  const enabledRules = rows
    .filter((row) => row.enabled)
    .map((row) => {
      // Validate hostname
      if (!row.hostname || row.hostname.trim() === "") {
        throw new Error(
          `Invalid exposure: hostname cannot be empty (port ${row.hostPort})`,
        );
      }

      // Validate port
      if (row.hostPort < 1 || row.hostPort > 65535) {
        throw new Error(
          `Invalid exposure: port ${row.hostPort} is out of range (must be 1-65535) for hostname ${row.hostname}`,
        );
      }

      const rule: IngressRule = {
        hostname: row.hostname,
        service: `${row.scheme}://localhost:${row.hostPort}`,
      };
      if (row.noTlsVerify) {
        rule.originRequest = { noTLSVerify: true };
      }
      return rule;
    });

  return [...enabledRules, { service: "http_status:404" }];
}

export function fingerprint(value: unknown): string {
  // Normalize the value before serializing to handle different representations
  // of the same data (undefined vs absent, different types, etc.)
  const normalize = (v: unknown): unknown => {
    if (v === null || v === undefined) {
      return null;
    }

    if (Array.isArray(v)) {
      return v.map(normalize);
    }

    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};

      // Sort keys and drop undefined values
      for (const key of Object.keys(obj).sort()) {
        const val = obj[key];
        if (val !== undefined) {
          normalized[key] = normalize(val);
        }
      }

      return normalized;
    }

    return v;
  };

  const normalized = normalize(value);
  const serialized = JSON.stringify(normalized);

  // Hash with SHA-256
  return createHash("sha256").update(serialized).digest("hex");
}

export type ConflictCheck = { ok: true } | { ok: false; reason: string };

export function checkForClobber(
  remote: unknown,
  lastWrittenFingerprint: string | null,
): ConflictCheck {
  // First push - check if adopting a tunnel with existing rules
  if (lastWrittenFingerprint === null) {
    // If remote is an array, check for hostname rules
    if (Array.isArray(remote)) {
      const hostnameRules = remote.filter(
        (rule): rule is { hostname: string } =>
          typeof rule === "object" &&
          rule !== null &&
          "hostname" in rule &&
          typeof rule.hostname === "string",
      );

      if (hostnameRules.length > 0) {
        const hostnames = hostnameRules.map((r) => r.hostname).join(", ");
        return {
          ok: false,
          reason: `Cannot adopt tunnel: remote has existing hostname rules (${hostnames}). Remove them manually or use a fresh tunnel.`,
        };
      }
    }

    return { ok: true };
  }

  const remoteFingerprint = fingerprint(remote);

  // Compare remote against what we last wrote
  if (remoteFingerprint === lastWrittenFingerprint) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "Remote configuration has been modified outside of Homestead",
  };
}
