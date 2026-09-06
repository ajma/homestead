import { z } from "zod";

export class ConfigError extends Error {}

export type Config = {
  dataDir: string;
  projectsDir: string;
  projectsHostDir: string;
  port: number;
  secretKey: string | undefined;
};

const absolutePath = z
  .string()
  .refine((v) => v.startsWith("/"), { message: "must be an absolute path" })
  .transform((v) => (v.length > 1 && v.endsWith("/") ? v.slice(0, -1) : v));

const schema = z.object({
  HOMESTACKS_DATA: absolutePath.default("/var/lib/homestacks"),
  HOMESTACKS_PROJECTS: absolutePath.default("/opt/stacks"),
  HOMESTACKS_PROJECTS_HOST: absolutePath.optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(7420),
  HOMESTACKS_SECRET_KEY: z.string().min(1).optional(),
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
    dataDir: v.HOMESTACKS_DATA,
    projectsDir: v.HOMESTACKS_PROJECTS,
    projectsHostDir: v.HOMESTACKS_PROJECTS_HOST ?? v.HOMESTACKS_PROJECTS,
    port: v.PORT,
    secretKey: v.HOMESTACKS_SECRET_KEY,
  };
}
