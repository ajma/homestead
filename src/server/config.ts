import { z } from "zod";

export class ConfigError extends Error {}

export type Config = {
  dataDir: string;
  projectsDir: string;
  projectsHostDir: string;
  webDir: string | undefined;
  port: number;
  secretKey: string | undefined;
  baseUrl: string;
  trustedOrigins: string[] | undefined;
};

const absolutePath = z
  .string()
  .refine((v) => v.startsWith("/"), { message: "must be an absolute path" })
  .transform((v) => (v.length > 1 && v.endsWith("/") ? v.slice(0, -1) : v));

/**
 * Validates one `scheme://host[:port]` origin.
 *
 * Shared by HOMESTEAD_TRUSTED_ORIGINS and HOMESTEAD_BASE_URL so both env
 * vars accept exactly the same syntax and reject the same mistakes.
 *
 * @returns an error message, or undefined when the origin is well-formed.
 */
function originError(origin: string): string | undefined {
  if (origin === "*") return "wildcard (*) not allowed";
  try {
    const url = new URL(origin);
    if (url.pathname !== "/" || url.search || url.hash) {
      return `origin must not contain path, query, or hash: ${origin}`;
    }
  } catch (err) {
    if (err instanceof TypeError) return `invalid origin format: ${origin}`;
    throw err;
  }
  return undefined;
}

const trustedOrigins = z
  .string()
  .optional()
  .superRefine((v, ctx) => {
    if (!v || v.trim() === "") return;
    const origins = v.split(",").map((s) => s.trim());
    for (const origin of origins) {
      const message = originError(origin);
      if (message) {
        ctx.addIssue({ code: "custom", message });
        return;
      }
    }
  })
  .transform((v) => {
    if (!v || v.trim() === "") return undefined;
    return v.split(",").map((s) => s.trim());
  });

const baseUrl = z
  .string()
  .optional()
  .superRefine((v, ctx) => {
    if (!v || v.trim() === "") return;
    const message = originError(v.trim());
    if (message) ctx.addIssue({ code: "custom", message });
  })
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  HOMESTEAD_DATA: absolutePath.default("/var/lib/homestead"),
  HOMESTEAD_PROJECTS: absolutePath.default("/opt/stacks"),
  HOMESTEAD_PROJECTS_HOST: absolutePath.optional(),
  HOMESTEAD_WEB_DIR: absolutePath.optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(7420),
  HOMESTEAD_SECRET_KEY: z.string().min(1).optional(),
  HOMESTEAD_BASE_URL: baseUrl,
  HOMESTEAD_TRUSTED_ORIGINS: trustedOrigins,
});

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }
  const v = parsed.data;
  return {
    dataDir: v.HOMESTEAD_DATA,
    projectsDir: v.HOMESTEAD_PROJECTS,
    projectsHostDir: v.HOMESTEAD_PROJECTS_HOST ?? v.HOMESTEAD_PROJECTS,
    webDir: v.HOMESTEAD_WEB_DIR,
    port: v.PORT,
    secretKey: v.HOMESTEAD_SECRET_KEY,
    // Better-Auth checks the browser's Origin header against this value, and
    // derives useSecureCookies from its scheme. It must be the URL operators
    // actually browse to; the localhost default only suits local development.
    baseUrl: v.HOMESTEAD_BASE_URL ?? `http://localhost:${v.PORT}`,
    trustedOrigins: v.HOMESTEAD_TRUSTED_ORIGINS,
  };
}
