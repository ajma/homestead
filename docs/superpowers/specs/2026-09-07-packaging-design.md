# Packaging — Design

**Status:** approved for planning
**Supersedes:** §12 of `2026-09-05-homestead-design.md`, which this narrows and amends

---

## 1. Purpose

Turn the repository into something a person can run on their NAS.

Today there is no build step at all — no server bundle, no compiled web assets,
no image. This plan produces a container anyone can pull and a compose file they
can paste, plus the startup checks that tell them when their environment is wrong.

### 1.1 Not in scope

- **The native install.** This plan builds the container only. A systemd unit,
  an installer, user and group setup and a Compose v2 assertion are a second
  delivery path to keep working, and a NAS audience runs containers. Product
  design §12 originally called Docker and native "co-equal"; it has since been
  amended to match, and now records the native install as designed but not
  built.
- **The path-translation preflight.** §12.3 proposed writing a nonce into the
  projects directory and asking the daemon to bind-mount the host path into a
  throwaway container to prove the two agree. Deliberately dropped: it costs a
  container launch at every boot to catch a misconfiguration that only arises
  when someone departs from the documented compose file.
- Publishing to any registry other than GitHub's, and any release process beyond
  a tag.

---

## 2. Build

`pnpm build` produces two artifacts:

- **Server** — tsup, ESM, Node target, bundled to `dist/server`.
- **Web** — `vite build` to `dist/web`.

**One Node process serves both**: the Fastify app serves the API and the built
SPA from the same port. That keeps the container to a single process with no
reverse proxy, no supervisor, and one thing to restart.

---

## 3. The image

Multi-stage, Node LTS Alpine.

The runtime layer installs `docker-cli` and `docker-cli-compose`, so **Homestead
carries its own Compose v2** rather than inheriting whatever the host has. That
matters on a NAS: several ship only Compose v1, whose `docker-compose` binary
this product does not support, and the whole design rests on the Compose CLI
being the specification interpreter.

Built for `linux/amd64` and `linux/arm64`. Most NAS hardware is aarch64, and an
amd64-only image will not start there at all.

The image does **not** bundle a `.env` or any secret. `$HOMESTEAD_DATA` is a
volume, and the secret key is generated into it on first run at `0600`.

---

## 4. The compose file

What a user pastes:

```yaml
services:
  homestead:
    image: ghcr.io/<owner>/homestead:latest
    network_mode: host
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /volume2/docker:/volume2/docker
      - /volume2/docker/.homestead:/data
    environment:
      HOMESTEAD_DATA: /data
      HOMESTEAD_PROJECTS: /volume2/docker
      HOMESTEAD_PROJECTS_HOST: /volume2/docker
```

**`network_mode: host` is not optional.** A bridged container's `127.0.0.1` is
its own loopback, so every local health probe — the `tcp` and `http` checks the
dashboard depends on — would fail against the container itself rather than the
service.

The stacks directory is mounted at the **same path inside and out**, which is why
no translation is needed and why the dropped preflight would have found nothing.
`HOMESTEAD_PROJECTS_HOST` exists for anyone who departs from that, and the
documentation must say plainly what it is for.

`$HOMESTEAD_DATA` holds the database, the secret key, and — new in the dashboard
plan — the icon cache at `icons/`. It must be a persistent volume or a user loses
their history and re-fetches every icon on each restart.

---

## 5. Startup checks

Run once, before serving. **None of them blocks startup.**

| Check | Failure means |
|---|---|
| Docker socket reachable | Every project action will fail |
| Compose v2 present | Project actions will fail; v1 is not supported |
| `$HOMESTEAD_DATA` writable | Nothing persists |
| `$HOMESTEAD_DATA` not on a network filesystem | **The database will corrupt** |
| `$HOMESTEAD_PROJECTS` readable | No projects and no apps will be found |
| Listen port free | Startup fails anyway; the check names why |

### 5.1 Warn and continue, and why the warnings must be visible

The operator chose warn-and-continue so that a misconfigured instance still comes
up far enough to be fixed through its own UI. That is a reasonable trade, and it
has one consequence that must be designed for rather than left implicit: **a
warning nobody reads is the same as no check at all.** A log line at boot on a
headless NAS is exactly that.

So failed checks are surfaced in the UI as a persistent banner naming each one and
what it means, not only written to the log.

**The network-filesystem check is different in kind and its wording says so.**
Every other failure produces visible errors — actions fail, nothing appears. That
one produces *silent corruption*: SQLite's locking is unreliable over NFS and SMB,
and the database degrades quietly rather than erroring. Its banner states that
data loss is possible and that the fix is to move `$HOMESTEAD_DATA` to local
storage.

Detection reads the filesystem type of the data directory's mount and matches a
known set (`nfs`, `nfs4`, `cifs`, `smb3`, `fuse.sshfs`, `9p`). An unrecognised
type is not reported as a failure — a false alarm about corruption would teach
people to ignore the banner, which is the one outcome worse than not checking.

---

## 6. Release

A GitHub Actions workflow builds both architectures with buildx and publishes to
GitHub's container registry on a version tag. It needs **no configured secrets**:
the token Actions provides already grants package write.

This repository has no remote today, so the workflow is inert until one exists.
That is accepted, and the plan records it: **its first real execution is its first
test**, so it stays as simple as it can be — build, tag, push, nothing clever.

---

## 7. Failure modes worth naming

| Situation | Behaviour |
|---|---|
| Docker socket missing | Banner; UI works; project actions fail with their own errors |
| Only Compose v1 on the host | Irrelevant — the image carries its own v2 |
| `$HOMESTEAD_DATA` on NFS | Banner warning of possible data loss; Homestead runs |
| `$HOMESTEAD_DATA` not writable | Banner; migrations will fail loudly on their own |
| Port already in use | Startup fails; the check has already named the port |
| Bridged networking instead of host | Local probes fail, so every app reads down. Documented prominently, since the symptom points at the apps rather than at the networking |
| Image pulled on the wrong architecture | Container will not start; multi-arch build is why this should not happen |

---

## 8. Testing

- **No test starts a container, reaches the network, or uses a real timer.** The
  checks take injected probes — a socket prober, a filesystem-type reader, a port
  prober — so each failure path is exercised without arranging the failure.
- A test asserts that **a failed check does not prevent startup**, since that is
  the whole point of the chosen behaviour and the easiest thing to regress.
- A test asserts the network-filesystem check reports **nothing** for an
  unrecognised filesystem type, because a false corruption warning is worse than
  a missing one.
- The banner is asserted to list every failed check, not merely to appear.
- The Dockerfile is linted in CI; the image build itself is not exercised by the
  test suite.

---

## 9. Handoff

- ~~The native install remains unbuilt and the product design still promises
  it.~~ **Resolved:** §12 was amended to match what shipped — container only,
  with the native install recorded as designed but not built, and the dropped
  path-translation check removed from §12.3.
- The Actions workflow is untested until a remote exists.
