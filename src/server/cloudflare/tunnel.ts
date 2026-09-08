import type { CloudflareClient } from "./client.js";

export type IngressRule = {
  hostname?: string;
  service: string;
  originRequest?: { noTLSVerify?: boolean };
};

export async function createTunnel(
  c: CloudflareClient,
  accountId: string,
  name: string,
): Promise<{ id: string }> {
  try {
    return await c.request<{ id: string }>(
      "POST",
      `/accounts/${accountId}/cfd_tunnel`,
      {
        name,
        config_src: "cloudflare",
      },
    );
  } catch (error) {
    throw new Error(
      `Failed to create tunnel "${name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function getTunnelToken(
  c: CloudflareClient,
  accountId: string,
  tunnelId: string,
): Promise<string> {
  try {
    // Cloudflare returns the run token as the result itself — a bare string,
    // not an object with a token field. Reading `.token` produced undefined,
    // which travelled as far as encrypt() before failing, three frames from
    // the cause. The object form is accepted too: this was got wrong once, so
    // do not assume the other shape never appears.
    const result = await c.request<string | { token?: string } | null>(
      "GET",
      `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
    );
    const token =
      typeof result === "string" ? result : (result?.token ?? undefined);
    if (!token) {
      throw new Error("Cloudflare returned no run token");
    }
    return token;
  } catch (error) {
    throw new Error(
      `Failed to get token for tunnel ${tunnelId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function getIngress(
  c: CloudflareClient,
  accountId: string,
  tunnelId: string,
): Promise<IngressRule[]> {
  try {
    // A tunnel that has never been configured returns a null configuration
    // rather than an empty one — which is the state of every tunnel Homestead
    // has just created, so the first reconcile after setup hit exactly this.
    // Absent config means no ingress; it must not mean "give up".
    const result = await c.request<{
      config?: { ingress?: IngressRule[] } | null;
    } | null>(
      "GET",
      `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
    );
    return result?.config?.ingress ?? [];
  } catch (error) {
    throw new Error(
      `Failed to get ingress for tunnel ${tunnelId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function putIngress(
  c: CloudflareClient,
  accountId: string,
  tunnelId: string,
  rules: IngressRule[],
): Promise<void> {
  try {
    // Remove any catch-all rules from the input and collect hostname rules
    const hostnameRules = rules.filter((r) => r.hostname !== undefined);

    // Always append exactly one catch-all at the end
    const finalRules = [...hostnameRules, { service: "http_status:404" }];

    await c.request(
      "PUT",
      `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
      {
        config: {
          ingress: finalRules,
        },
      },
    );
  } catch (error) {
    throw new Error(
      `Failed to update tunnel ${tunnelId} ingress: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function upsertDnsRecord(
  c: CloudflareClient,
  zoneId: string,
  hostname: string,
  tunnelId: string,
): Promise<void> {
  try {
    // List existing DNS records
    const records = await c.request<
      Array<{ id: string; name: string; type: string; content: string }>
    >("GET", `/zones/${zoneId}/dns_records`);

    // Find all records matching this hostname
    const matching = records.filter((r) => r.name === hostname);

    // Refuse if multiple records exist
    if (matching.length > 1) {
      throw new Error(
        `DNS conflict: hostname ${hostname} has ${matching.length} existing records (${matching.map((r) => `${r.type} ${r.content}`).join(", ")}). Cannot create tunnel CNAME.`,
      );
    }

    const tunnelTarget = `${tunnelId}.cfargotunnel.com`;
    const recordData = {
      type: "CNAME",
      name: hostname,
      content: tunnelTarget,
      proxied: true,
    };

    if (matching.length === 1) {
      // biome-ignore lint/style/noNonNullAssertion: matching.length === 1 guarantees matching[0] exists
      const existing = matching[0]!;

      // If it's a CNAME pointing at our tunnel, update it (idempotent)
      if (existing.type === "CNAME" && existing.content === tunnelTarget) {
        await c.request(
          "PATCH",
          `/zones/${zoneId}/dns_records/${existing.id}`,
          recordData,
        );
        return;
      }

      // If it's a CNAME pointing elsewhere, refuse
      if (existing.type === "CNAME") {
        throw new Error(
          `DNS conflict: hostname ${hostname} already has a CNAME pointing to ${existing.content}. Cannot overwrite with tunnel CNAME to ${tunnelTarget}.`,
        );
      }

      // If it's a different record type, refuse
      throw new Error(
        `DNS conflict: hostname ${hostname} already has type ${existing.type} record pointing to ${existing.content}. Cannot overwrite with tunnel CNAME.`,
      );
    }

    // No existing record, create new CNAME
    await c.request("POST", `/zones/${zoneId}/dns_records`, recordData);
  } catch (error) {
    // If it's already our error with context, re-throw as-is
    if (error instanceof Error && error.message.includes("DNS conflict")) {
      throw error;
    }
    // Otherwise wrap with context
    throw new Error(
      `Failed to upsert DNS record for ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function deleteDnsRecord(
  c: CloudflareClient,
  zoneId: string,
  hostname: string,
): Promise<void> {
  try {
    // List existing DNS records
    const records = await c.request<Array<{ id: string; name: string }>>(
      "GET",
      `/zones/${zoneId}/dns_records`,
    );

    const existing = records.find((r) => r.name === hostname);

    if (existing) {
      await c.request("DELETE", `/zones/${zoneId}/dns_records/${existing.id}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to delete DNS record for ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
