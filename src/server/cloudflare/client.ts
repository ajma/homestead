import type { IdpOption, ZoneOption } from "@shared/cloudflare.js";

type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors: { code: number; message: string }[];
};

export type CloudflareClient = {
  verifyToken(): Promise<{ ok: true } | { ok: false; missingScopes: string[] }>;
  listAccounts(): Promise<{ id: string; name: string }[]>;
  listZones(accountId: string): Promise<ZoneOption[]>;
  listIdentityProviders(accountId: string): Promise<IdpOption[]>;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
};

export function createCloudflareClient(opts: {
  token: string;
  fetch?: typeof fetch;
}): CloudflareClient {
  const fetchFn = opts.fetch ?? fetch;
  const baseUrl = "https://api.cloudflare.com/client/v4";

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      // Network error, DNS failure, etc.
      throw new Error(
        `Cloudflare API network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Parse body defensively - read as text first, then attempt JSON
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(
        `Cloudflare API error (${response.status}): response is not valid JSON`,
      );
    }

    // Validate envelope structure
    if (!data || typeof data !== "object") {
      throw new Error(
        `Cloudflare API error (${response.status}): response is not a valid envelope`,
      );
    }

    const envelope = data as Partial<CloudflareEnvelope<T>>;

    // Cloudflare returns HTTP 200 with success: false for some failures
    if (!envelope.success) {
      const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
      const errorMessage =
        errors.length > 0
          ? errors.map((e) => e?.message || "Unknown error").join("; ")
          : "Unknown error";
      // Never include the token in the error message
      throw new Error(
        `Cloudflare API error (${response.status}): ${errorMessage}`,
      );
    }

    return envelope.result as T;
  }

  return {
    request,

    async verifyToken() {
      const probes: { scope: string; path: string }[] = [
        { scope: "Account:Read", path: "/accounts" },
        { scope: "Zone:Read", path: "/zones" },
      ];

      const missingScopes: string[] = [];

      for (const probe of probes) {
        try {
          await request("GET", probe.path);
        } catch (error) {
          // Only error code 9109 indicates insufficient permissions (missing scope)
          // Other 403s (10000 = bad token, rate limits, suspended accounts) are not scope issues
          if (
            error instanceof Error &&
            error.message.includes("(403)") &&
            error.message.includes("Unauthorized")
          ) {
            // This is a heuristic - Cloudflare error 9109 includes "Unauthorized"
            missingScopes.push(probe.scope);
          }
          // Other errors (bad token, network, 500, etc.) don't indicate missing scopes
        }
      }

      if (missingScopes.length > 0) {
        return { ok: false, missingScopes };
      }

      return { ok: true };
    },

    async listAccounts() {
      type Account = { id: string; name: string };
      const accounts = await request<Account[]>("GET", "/accounts");
      // Defend against null result - return empty array rather than letting null.map() explode downstream
      if (!accounts) return [];
      return accounts.map((a) => ({ id: a.id, name: a.name }));
    },

    async listZones(accountId: string) {
      // Zones are a top-level collection filtered by account, not a
      // sub-resource of one. /accounts/{id}/zones does not exist and answers
      // 400 "No route for that URI".
      const zones = await request<ZoneOption[]>(
        "GET",
        `/zones?account.id=${encodeURIComponent(accountId)}`,
      );
      // Defend against null result
      return zones ?? [];
    },

    async listIdentityProviders(accountId: string) {
      const idps = await request<IdpOption[]>(
        "GET",
        `/accounts/${accountId}/access/identity_providers`,
      );
      // Defend against null result
      return idps ?? [];
    },
  };
}
