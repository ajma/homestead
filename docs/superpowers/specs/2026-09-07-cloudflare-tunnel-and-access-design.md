# Cloudflare Tunnel and Access — Design

**Status:** approved for planning
**Supersedes:** §8 of `2026-09-05-homestead-design.md`, which this expands and amends
**Depends on:** the monitoring engine from `2026-09-06-monitoring-and-devices-design.md`

---

## 1. Purpose

Publish a service running on the Homestead box at a real hostname, behind a login,
without opening a port on the router.

Three things have to be true at once for that to be useful. The hostname must
resolve and route — that is the tunnel. Only people you allow may reach it — that
is Access. And Homestead must be able to tell you whether it is actually working —
that is a probe, which has to get *through* Access to mean anything.

This plan builds all three. It does not build the dashboard that will link to
these hostnames; that follows.

### 1.1 Order

This work comes before the dashboard, deliberately. The dashboard's tiles link to
exposure hostnames and one of its two probes is the public URL, so building it
first would mean building tile links twice.

### 1.2 Not in scope

- **Non-HTTP exposures.** Access protects HTTP applications. Tunnelling a raw TCP
  service — a database, SSH — works through `cloudflared access tcp` on the
  client, which is a different model with a different threat profile. Exposures
  here are HTTP or HTTPS origins. §10 says what happens when someone tries.
- Configuring an identity provider. Homestead reads them; it never creates one.
- The dashboard, tiles, icons, and per-viewer app visibility.

---

## 2. Model

One shared, remotely-managed tunnel per Homestead instance, created with
`config_src: "cloudflare"`. Ingress rules are pushed from Cloudflare, so adding a
hostname requires no daemon restart and no file on disk.

```
Homestead (SQLite, authoritative)
   │
   ├── exposures ──push──▶ tunnel ingress array   (full replace)
   │                  └──▶ DNS CNAME per hostname
   │
   └── users ──────push──▶ "Homestead — allowed users" policy   (reusable)
                      └──▶ one Access application per exposure
```

**SQLite is authoritative; Cloudflare is a projection.** Every push is a full
rebuild from local state inside a transaction. Concurrent edits serialise against
the transaction rather than a network round-trip, because a read-modify-write over
a full-replace API only narrows the race, it does not close it.

---

## 3. Data model

### 3.1 `exposures`

| Column | Notes |
|---|---|
| `id` | uuid |
| `projectSlug` | **nullable** — an exposure is fundamentally "host port → hostname", so a bare host service or an unmanaged stack can be tunnelled |
| `hostPort` | integer; the join key |
| `zoneId` | which domain this hostname lives under |
| `hostname` | fully qualified |
| `scheme` | `http` or `https` |
| `noTlsVerify` | boolean; some apps (Unifi, Proxmox) serve HTTPS with a self-signed certificate and `cloudflared` refuses them by default |
| `label` | nullable, display-only |
| `enabled` | boolean |
| `accessEnabled` | boolean, default **true** |
| `accessAppId` | nullable; set when an Access application exists |

**No service name is stored.** With host networking the origin is
`http://localhost:<hostPort>`; the port is the wiring and the service name is a
label attached to it. Storing both stores a derivation beside its source and they
drift — rename a service, or move a port to a front-end, and the stored name points
at nothing while routing keeps working. The name is derived at read time from
`docker compose config`. `label` is the fallback for when derivation fails.

### 3.2 Settings

Encrypted with the existing AES-256-GCM helper in `src/server/crypto/secrets.ts`:
`cloudflare.apiToken`, `cloudflare.serviceTokenClientId`,
`cloudflare.serviceTokenSecret`.

Plaintext: `cloudflare.accountId`, `cloudflare.tunnelId`, `cloudflare.idpId`,
`cloudflare.policyAllowId`, `cloudflare.policyProbeId`.

### 3.3 Reconciler state

`cloudflare.lastPushedIngress` and `cloudflare.lastPushedPolicy` store a hash of
what Homestead last wrote. §7 explains why a hash of intent, rather than a
comparison against desired state, is what makes clobber-detection possible.

---

## 4. Setup

1. **API token.** The user supplies one. Required scopes: Account →
   *Cloudflare Tunnel: Edit*, *Access: Apps and Policies: Edit*, *Access: Service
   Tokens: Edit*; Zone → *DNS: Edit*, *Zone: Read*. Homestead verifies the token
   and lists accounts for selection. A token missing a scope fails here, with the
   missing scope named — not later, halfway through creating a hostname.
2. **Tunnel.** `POST /accounts/{account_id}/cfd_tunnel` with
   `config_src: "cloudflare"`, then `GET …/cfd_tunnel/{id}/token` for the run token.
3. **Identity provider.** `GET /accounts/{account_id}/access/identity_providers`.
   The user picks one.
   **If the account has none, setup stops here** with a link to the Cloudflare
   dashboard. Access-by-default cannot be honoured without an identity provider,
   and continuing would create unprotected hostnames while implying they were
   protected. Failing loudly is the only safe branch.
4. **Reusable policies.** Two, created once — see §6.
5. **Service token.** One, created once, for Homestead's own probes — see §8.
6. **Runtime.** See §5.

---

## 5. Running `cloudflared`

Two supported paths.

**Adopt.** If a `cloudflared` container is already running, Homestead offers to
reuse it rather than starting a second daemon competing for the same tunnel.
Adoption records the container id and confirms the tunnel matches.

**Deploy.** Otherwise Homestead writes `$HOMESTEAD_PROJECTS/homestead-tunnel/`
containing a compose file with `network_mode: host`, the run token in `.env`, and
`x-homestead.system: true`.

Deploying it *as a Homestead project* is the point: it inherits logs, restart,
image updates and the operations history from machinery that already exists and is
already tested. It must live under `$HOMESTEAD_PROJECTS` because its compose path
is passed to the daemon.

A systemd unit for a native `cloudflared` on `PATH` is **not** built. It is the
most host-invasive option and the hardest to test.

---

## 6. Access

### 6.1 Two reusable policies, created once

| Policy | `decision` | Rules |
|---|---|---|
| `Homestead — allowed users` | `allow` | `include`: one `email` selector per Homestead user · `require`: `{ login_method: { id: <idp_id> } }` |
| `Homestead — probe` | `non_identity` | `include`: `{ service_token: { token_id } }` |

The split between `include` and `require` matters and is easy to get backwards.
Cloudflare treats `include` as *any of* and `require` as *all of*. Putting the
identity provider in `include` alongside the emails would mean "a listed email **or**
anyone who can log in through this provider" — which, with a public provider like
Google, admits the entire internet. The emails go in `include`; the provider goes in
`require`.

Created with `POST /accounts/{account_id}/access/policies` and referenced **by id**
from every application.

Reusable rather than inline, for three reasons. Revoking a person becomes one edit
instead of one per hostname. The reconciler diffs stable ids rather than inlined
rule bodies. And Cloudflare's own documentation is explicit that removing a
*legacy* inline policy from an application **deletes** that policy — so with inline
policies, deleting one exposure could destroy the access rules for all of them.

**Invariant: deleting an exposure never deletes a shared policy.** It deletes the
application and the DNS record only. This gets an explicit test, because it is the
kind of cascade that looks correct until the second exposure disappears.

### 6.2 One application per exposure

`POST /accounts/{account_id}/access/apps` with `type: "self_hosted"`, the
`domain` set to the hostname, and `policies` referencing the two ids above.

### 6.3 Opting out

`accessEnabled: false` creates no Access application, leaving the hostname fully
public. This is a deliberate choice the operator may need — a public status page, a
webhook receiver — but it is the one action here that can put an unauthenticated
service on the internet.

It is therefore an explicit, clearly-labelled action stating what will happen, not
a quiet checkbox. No port allowlist or blocklist guards it: an admin is already
root-equivalent on this host, Access covers the accidental case, and a
confirmation on every exposure would train people to click through the one that
mattered.

### 6.4 Keeping the allow policy in sync

The `allowed users` policy is **continuously synced** to Homestead's user list:
creating, deleting or re-emailing a user rewrites it, and a reconcile runs at
startup. Both admins and viewers are included — Access governs reaching the
published app, not administering Homestead.

Continuous sync means Homestead asserts ownership of that policy's contents, which
would ordinarily overwrite any rule added by hand in the Cloudflare dashboard. It
does not, because the clobber-detection in §7 applies here too: Homestead compares
the remote policy against a hash of what it last wrote, and an unrecognised change
halts the sync and raises adopt-or-overwrite. Manual edits are surfaced, not
destroyed.

---

## 7. The reconciler

`PUT /accounts/{account_id}/cfd_tunnel/{id}/configurations` **replaces the entire
ingress array.** There is no add-one endpoint, and the array must end with a
catch-all.

```
desired = [ …enabled exposures, { service: "http_status:404" } ]
PUT  /accounts/{acct}/cfd_tunnel/{id}/configurations
then per hostname: CNAME → {tunnel_id}.cfargotunnel.com, proxied: true
```

**It refuses to clobber.** Before each push it compares remote state against the
hash of what it last wrote. Rules it does not recognise stop the push and raise an
adopt-or-overwrite prompt.

The comparison is against *what Homestead last wrote*, not against *what Homestead
now wants*. Those differ precisely when someone edited Cloudflare by hand, which is
the case worth catching — comparing against desired state would report every local
change as foreign drift and make the prompt meaningless.

Removing an exposure also deletes its DNS record and its Access application.

---

## 8. Probing through Access

An Access-protected hostname bounces an anonymous probe to a login page. A probe
that treats a login redirect as success cannot tell a healthy app from a crashed
one behind a working tunnel.

So Homestead mints one Access service token and sends `CF-Access-Client-Id` and
`CF-Access-Client-Secret` on its own probes. The `Homestead — probe` policy admits
it. A public check then tests the real path end to end: DNS, tunnel, Access, and
the application behind it.

**This is a new monitor type in the Plan 5 engine, not a parallel mechanism.** The
runner, retries, backoff, history and rollups all apply unchanged. `push` and
`tailscale` already established that a check need not be a plain network call.

The service token is a credential: encrypted at rest, never logged, never returned
by any route, never rendered into the DOM.

---

## 9. Permissions

Exposure management is **admin-only** — creating, editing, deleting, and reading
the exposure list. A viewer never sees hostnames, tokens, or the Cloudflare
account id.

`src/server/auth/permissions.ts` gains one resource, `exposure`, with
`["read", "create", "update", "delete"]` on `adminRole` and nothing on
`viewerRole`. Homestead holds the Docker socket, so that file is the one place
where a mistake hands over the machine; the change is two lines and nothing else.

---

## 10. Failure modes worth naming

| Situation | Behaviour |
|---|---|
| Account has no identity provider | Setup stops with a link; no hostname is created |
| API token missing a scope | Rejected at setup, naming the scope |
| Someone hand-edited tunnel ingress | Push halts, adopt-or-overwrite prompt |
| Someone hand-edited the allow policy | Sync halts, adopt-or-overwrite prompt |
| A second `cloudflared` is already running | Offered for adoption rather than competing |
| Exposure points at a port that does not speak HTTP | Created, since Homestead cannot reliably know in advance, but the probe fails and says why. Access cannot protect a non-HTTP origin, so this reads as a misconfiguration rather than a supported mode |
| Cloudflare API unreachable | Local state unchanged; the **instance** is marked out-of-sync and retried, never silently dropped. Sync state is per-instance rather than per-exposure because ingress is pushed as one whole array — a failed push leaves every exposure unpushed together, and a per-row flag would imply a granularity the API does not have |

---

## 11. Testing

- **No test reaches Cloudflare.** The API client takes an injectable `fetch`, as
  the Tailscale client does, and every test uses a fake.
- The reconciler's full-replace behaviour is tested by asserting the *entire*
  pushed array, including the trailing catch-all — a test asserting only that a
  hostname appears would pass while silently dropping every other exposure.
- Clobber-detection is tested by mutating remote state behind Homestead's back and
  asserting the push halts.
- The delete-an-exposure path asserts the two shared policies still exist.
- A viewer is refused every exposure route, one test per route.
- The stored API token and service token do not contain their plaintext.

---

## 12. Handoff to the dashboard plan

- Tiles link to `exposures.hostname`, joined on `hostPort`.
- The reachability monitor type built here becomes the app's public probe.
- Status stays a three-state dot with the confidence tier as detail text.
- Apps come from managed project services and manual rows; container discovery is
  not planned.
