import { z } from "zod";

const optionalString = z
  .string()
  .transform((v) => (v.trim() === "" ? null : v.trim()))
  .nullable()
  .default(null);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOMESTEAD_SECRET_KEY: z.string().min(1),
  HOMESTEAD_DB_PATH: z.string().default("./data/homestead.db"),
  HOMESTEAD_COMPOSE_ROOT: z.string().default("/volume2/docker"),
  HOMESTEAD_DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  HOMESTEAD_BASE_URL: z.url(),
  HOMESTEAD_TRUSTED_ORIGINS: z.string().default(""),
  // Peers whose X-Forwarded-For / CF-Connecting-IP headers may be believed.
  // Defaults to loopback: cloudflared runs with network_mode: host and reaches
  // Homestead over localhost, while LAN clients connect from a LAN address.
  HOMESTEAD_TRUSTED_PROXIES: z.string().default("127.0.0.1,::1"),
  HOMESTEAD_ACCESS_TEAM_DOMAIN: optionalString,
  HOMESTEAD_ACCESS_AUD: optionalString,
  HOMESTEAD_SKIP_MOUNT_PREFLIGHT: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
});

export type Config = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  secretKey: Buffer;
  dbPath: string;
  composeRoot: string;
  dockerSocket: string;
  baseUrl: string;
  trustedOrigins: string[];
  trustedProxies: string[];
  accessTeamDomain: string | null;
  accessAud: string | null;
  accessEnabled: boolean;
  skipMountPreflight: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.parse(env);

  const secretKey = Buffer.from(parsed.HOMESTEAD_SECRET_KEY, "base64");
  if (secretKey.length !== 32) {
    throw new Error(
      `HOMESTEAD_SECRET_KEY must decode to exactly 32 bytes, got ${secretKey.length}. ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  const extraOrigins = parsed.HOMESTEAD_TRUSTED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");

  const trustedOrigins = [...new Set([parsed.HOMESTEAD_BASE_URL, ...extraOrigins])];

  const trustedProxies = parsed.HOMESTEAD_TRUSTED_PROXIES.split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");

  const accessTeamDomain = parsed.HOMESTEAD_ACCESS_TEAM_DOMAIN;
  const accessAud = parsed.HOMESTEAD_ACCESS_AUD;

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    secretKey,
    dbPath: parsed.HOMESTEAD_DB_PATH,
    composeRoot: parsed.HOMESTEAD_COMPOSE_ROOT,
    dockerSocket: parsed.HOMESTEAD_DOCKER_SOCKET,
    baseUrl: parsed.HOMESTEAD_BASE_URL,
    trustedOrigins,
    trustedProxies,
    accessTeamDomain,
    accessAud,
    accessEnabled: accessTeamDomain !== null && accessAud !== null,
    skipMountPreflight: parsed.HOMESTEAD_SKIP_MOUNT_PREFLIGHT,
  };
}
