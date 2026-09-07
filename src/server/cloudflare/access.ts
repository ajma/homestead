import type { CloudflareClient } from "./client.js";

export type PolicyRule = Record<string, Record<string, string>>;

function normalizeEmails(emails: string[]): string[] {
  const normalized = emails
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return [...new Set(normalized)];
}

export async function createAllowPolicy(
  c: CloudflareClient,
  accountId: string,
  idpId: string,
  emails: string[],
): Promise<{ id: string }> {
  const normalizedEmails = normalizeEmails(emails);
  if (normalizedEmails.length === 0) {
    throw new Error("Access policy must name at least one user");
  }
  const result = await c.request<{ id: string }>(
    "POST",
    `/accounts/${accountId}/access/policies`,
    {
      name: "Homestead — allowed users",
      decision: "allow",
      include: normalizedEmails.map((email) => ({ email: { email } })),
      require: [{ login_method: { id: idpId } }],
    },
  );
  return result;
}

export async function updateAllowPolicy(
  c: CloudflareClient,
  accountId: string,
  policyId: string,
  idpId: string,
  emails: string[],
): Promise<void> {
  const normalizedEmails = normalizeEmails(emails);
  if (normalizedEmails.length === 0) {
    throw new Error("Access policy must name at least one user");
  }
  await c.request("PUT", `/accounts/${accountId}/access/policies/${policyId}`, {
    name: "Homestead — allowed users",
    decision: "allow",
    include: normalizedEmails.map((email) => ({ email: { email } })),
    require: [{ login_method: { id: idpId } }],
  });
}

export async function getPolicy(
  c: CloudflareClient,
  accountId: string,
  policyId: string,
): Promise<{ include: PolicyRule[]; require: PolicyRule[] }> {
  const result = await c.request<{
    include: PolicyRule[];
    require: PolicyRule[];
  }>("GET", `/accounts/${accountId}/access/policies/${policyId}`);
  return result;
}

export async function createProbePolicy(
  c: CloudflareClient,
  accountId: string,
  serviceTokenId: string,
): Promise<{ id: string }> {
  const result = await c.request<{ id: string }>(
    "POST",
    `/accounts/${accountId}/access/policies`,
    {
      name: "Homestead — probe",
      decision: "non_identity",
      include: [{ service_token: { token_id: serviceTokenId } }],
    },
  );
  return result;
}

export async function createServiceToken(
  c: CloudflareClient,
  accountId: string,
  name: string,
): Promise<{ id: string; clientId: string; clientSecret: string }> {
  const result = await c.request<{
    id: string;
    client_id: string;
    client_secret: string;
  }>("POST", `/accounts/${accountId}/access/service_tokens`, {
    name,
  });
  if (!result.client_secret) {
    throw new Error("Service token response missing client_secret");
  }
  return {
    id: result.id,
    clientId: result.client_id,
    clientSecret: result.client_secret,
  };
}

function validateHostname(hostname: string): string {
  if (hostname.includes("://")) {
    throw new Error("Hostname must not include a scheme (http:// or https://)");
  }
  if (hostname.includes("/")) {
    throw new Error("Hostname must not include a path");
  }
  if (hostname.includes(":")) {
    throw new Error("Hostname must not include a port");
  }
  if (hostname.endsWith(".")) {
    throw new Error("Hostname must not have a trailing dot");
  }
  const normalized = hostname.toLowerCase();
  const labels = normalized.split(".");
  if (labels.length < 2) {
    throw new Error("Hostname must have at least one label and a TLD");
  }
  return normalized;
}

export async function createApp(
  c: CloudflareClient,
  accountId: string,
  hostname: string,
  policyIds: string[],
): Promise<{ id: string }> {
  const validatedHostname = validateHostname(hostname);
  const result = await c.request<{ id: string }>(
    "POST",
    `/accounts/${accountId}/access/apps`,
    {
      name: validatedHostname,
      type: "self_hosted",
      domain: validatedHostname,
      policies: policyIds.map((id) => ({ id })),
    },
  );
  return result;
}

export async function deleteApp(
  c: CloudflareClient,
  accountId: string,
  appId: string,
): Promise<void> {
  try {
    await c.request("DELETE", `/accounts/${accountId}/access/apps/${appId}`);
  } catch (error) {
    // Already gone is success - deleting converges on "absent"
    if (error instanceof Error && error.message.includes("404")) {
      return;
    }
    throw error;
  }
}
