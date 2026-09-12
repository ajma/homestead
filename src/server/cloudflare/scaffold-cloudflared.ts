/**
 * The compose file and `.env` for the `cloudflared` app Homestead provisions for its one
 * remotely-managed tunnel (spec §6).
 *
 * Unlike `apps/scaffold.ts`'s `scaffoldCompose`, this function takes NO parameters. That
 * is deliberate, not an oversight: `scaffoldCompose` had to sanitise a display name before
 * letting it reach a `#` comment, because a newline in that name broke out of the comment
 * and injected a second `services:` block that `docker compose config` happily accepted
 * (see that file). This scaffold has no display name, no user-chosen anything — every
 * byte in `composeFile` is a literal this module wrote — so there is nothing for an
 * attacker-controlled string to break out of. If a future change adds a parameter here
 * (a custom image tag, an extra environment variable), it needs the same sanitisation
 * `scaffoldCompose` has, not a bare interpolation.
 *
 * Returns file *contents* rather than writing them — that keeps this a pure function with
 * exhaustive tests, and leaves the actual write (and its undo, on rollback) to the caller
 * that owns that responsibility.
 */

/**
 * `network_mode: host` is what lets cloudflared reach Homestead over loopback regardless
 * of which bridge network Homestead's own container sits on — see `config.ts`'s and
 * `app.ts`'s comments on `HOMESTEAD_TRUSTED_PROXIES`, both of which already assume this.
 *
 * `TUNNEL_TOKEN` is interpolated from the environment (`${TUNNEL_TOKEN}`), never written
 * into this file directly: the token is a credential (see `tunnel-store.ts`), and a
 * value baked into the compose file would put it in a file this project's own tooling
 * shows unmasked in a diff. It arrives via `.env`, which `maskEnv` already knows to mask
 * in the UI (see `scaffold-cloudflared.test.ts`).
 *
 * No `--token` flag on the command: the `cloudflared` image reads `TUNNEL_TOKEN` from its
 * environment directly, so the command needs no argument that could leak the token into
 * `docker inspect` output or a process listing on the host.
 *
 * `config_src: "cloudflare"` (asserted when the tunnel is created — see
 * `client.ts`'s `createTunnel`) is what makes this safe to run with no ingress
 * configuration of its own: cloudflared fetches its ingress rules from Cloudflare's API
 * on every connection, so this container never needs restarting when ingress changes.
 */
const COMPOSE_FILE = `# cloudflared
#
# Created by Homestead for its managed tunnel. Ingress is configured in Cloudflare's
# dashboard, not here — this container only needs to stay connected.
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    network_mode: host
    environment:
      TUNNEL_TOKEN: \${TUNNEL_TOKEN}
    command: tunnel --no-autoupdate run
`;

/** Empty rather than omitted: the key must exist so the app's `.env` tab has something to
 * show (and mask) immediately, before the provisioning step that owns writing the real
 * token ever runs. `TUNNEL_TOKEN=` with no value round-trips through `parseEnv` the same
 * as any other entry, and `upsertEnv` (see `env-file.ts`) is how the real value lands here
 * later — this scaffold never invents one itself. */
const ENV_FILE = "TUNNEL_TOKEN=\n";

export function scaffoldCloudflared(): { composeFile: string; envFile: string } {
  return { composeFile: COMPOSE_FILE, envFile: ENV_FILE };
}
