export type TailscaleDevice = {
  nodeId: string;
  name: string;
  hostname: string;
  os: string;
  addresses: string[];
  user: string;
  clientVersion: string;
  updateAvailable: boolean;
  tags: string[];
  isEphemeral: boolean;
  isExternal: boolean;
  blocksIncomingConnections: boolean;
  connectedToControl: boolean;
  lastSeen: string | undefined;
};

export type TailscaleClient = {
  listDevices(): Promise<TailscaleDevice[]>;
};

type TailscaleApiDevice = {
  nodeId: string;
  name: string;
  hostname: string;
  os: string;
  addresses: string[];
  user: string;
  clientVersion: string;
  updateAvailable: boolean;
  tags: string[];
  isEphemeral: boolean;
  isExternal: boolean;
  blocksIncomingConnections: boolean;
  connectedToControl: boolean;
  lastSeen?: string; // ISO string, omitted when device is online
};

export function createTailscaleClient(opts: {
  tailnet: string;
  token: string;
  fetch?: typeof fetch;
}): TailscaleClient {
  const fetchFn = opts.fetch ?? fetch;

  return {
    async listDevices(): Promise<TailscaleDevice[]> {
      const url = `https://api.tailscale.com/api/v2/tailnet/${opts.tailnet}/devices?fields=all`;
      const response = await fetchFn(url, {
        headers: {
          Authorization: `Bearer ${opts.token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Tailscale API error: ${response.status}`);
      }

      const data = (await response.json()) as { devices: TailscaleApiDevice[] };

      return data.devices.map((device) => ({
        nodeId: device.nodeId,
        name: device.name,
        hostname: device.hostname,
        os: device.os,
        addresses: device.addresses,
        user: device.user,
        clientVersion: device.clientVersion,
        updateAvailable: device.updateAvailable,
        tags: device.tags,
        isEphemeral: device.isEphemeral,
        isExternal: device.isExternal,
        blocksIncomingConnections: device.blocksIncomingConnections,
        connectedToControl: device.connectedToControl,
        lastSeen: device.lastSeen, // Keep as raw string from API
      }));
    },
  };
}
