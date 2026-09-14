# App catalogue — carry-forward

Written after the build, a whole-branch review, a fix wave, and two rounds of automated
security review. The scratch workspace is git-ignored and has been deleted.

## What shipped

Fifty popular self-hosted applications, no \*arr, browsable and keyword-searchable from the
create dialog. Choosing one fills display name, description, icon and compose file, and
everything stays editable. `GET /api/catalogue` is admin-only; the catalogue never enters the
client bundle.

Compose files are minimal and correct on `latest` tags, with persistent data in **relative bind
mounts** so it lands in `/volume2/docker/<app>/data` — spec §10's path-identity constraint is
what makes that work, and it is the difference between a backup that is "copy the folder" and
one that silently captures nothing.

## The thing worth knowing before touching this again

**`scripts/verify-catalogue.ts` proves an entry is valid and resolvable. It does not prove the
entry is good**, and it says so in its own output. It checks that compose resolves under the
real `docker compose config`, that the image exists in its registry, and that the icon slug
exists in dashboard-icons. It cannot check whether a volume points at the path the application
actually writes to.

The review found exactly that, twice, and only because someone went and ran the thing:

**`healthchecks` and `wiki-js` both mounted `./db:/var/lib/postgresql/data` against
`postgres:latest`.** Postgres 18 moved `PGDATA` to `/var/lib/postgresql/18/docker` and declares
`VOLUME /var/lib/postgresql`, so the bind mount caught nothing — measured live at **22 files in
the real datadir, 0 in the bind mount**. The database went to an anonymous volume that
`down -v` destroys. `miniflux` had it right in the same file; two spellings of one thing is how
it got through.

**`gitea` published `3000:3000`, which is Homestead's own port.** Grafana, Homepage and Wiki.js
had all been moved off 3000; Gitea was missed, so creating it from the catalogue failed
immediately.

Neither is exotic. Both would have shipped.

## Do these next

**1. Per-install secret generation.** Eleven acknowledged literals remain — internal
app-to-database passwords, identical across every install. They are on unpublished services so
the exposure is small, but the honest fix is generating them at create time and writing them to
the app's `.env`. `upsertEnv` already exists in `src/shared/env-file.ts` and the create flow
already writes a `.env`, so this is less work than it sounds.

**2. The catalogue will go stale, and nothing notices.** Images move, upstream compose changes,
projects are archived. `trilium` was already pointing at an image last pushed in June, and the
image-update checker would have reported it up to date forever. `photoview` and `it-tools` are
2+ years stale with no alternative. `check:schema-drift` is the precedent for a drift signal
here, and a catalogue is a weaker case for automation than a schema — but this is the gap.

**3. The acknowledgement mechanism is over-broad.** Acknowledging a key for the credential rule
also silences the placeholder rule, so `changeme1234` ships in a few entries. The new insecure-
flag rule was deliberately given its **own** list rather than widening the coupling; the older
two should be split the same way.

## Known gaps, consciously left

| # | Gap | Why |
|---|---|---|
| 1 | Content correctness is unverifiable by script | Stated in the plan, in the verifier's output, and again here. A reviewer's time is better spent spot-checking entries against upstream docs than re-reading the schema. |
| 2 | `PUID`/`PGID` excluded | The user's choice. Eleven entries carry a non-root warning in their description instead. |
| 3 | `photoview` and `it-tools` images are years stale | No actionable upstream alternative found. |
| 4 | NPM holds ports 80 and 443 | Inherent to ACME HTTP-01. Miniflux yielded to it, which is the right way round — a reverse proxy's claim on 80 is stronger than a feed reader's. |

## Things that must not be "simplified" later

- **Persistent data is a relative bind mount, never a named volume.** The whole promise is that
  an app's data sits under its own directory where a folder copy backs it up.
- **The port parser is protocol-aware and deduplicates within an entry.** Before that, a `tcp`
  and `udp` pair on one port read as a collision — which dropped Pi-hole, dropped Home
  Assistant for using `network_mode: host` with no published port, and split qBittorrent's and
  Syncthing's `6881` across two host ports so UDP peers hit the wrong one. A constraint that
  makes the content wrong is a bug in the constraint.
- **The security guard's exemptions are per-entry, per-key rows, visible in the same diff as the
  value they excuse** — not an ignore list that grows unnoticed. Making `isAcknowledged`
  slug-only left all eight tests green until a test pinned it.
- **`ARR_EXCLUSION_LIST` has a test naming the seven apps.** Emptying it left all 22 tests green;
  the user asked for that exclusion specifically.
- **The verifier's closing line disclaims what it cannot know.** Do not delete it to make the
  output tidier.

## The pattern

Two automated security reviews fired on this branch and both were right. The first caught
invented `changeme` credentials; the second caught a `N8N_SECURE_COOKIE=false` that **the fix
wave for the first one had added**, to make the entry work over plain HTTP on a LAN.

That second one is the interesting one. The investigation behind it was sound — the implementer
correctly established n8n's default from its own source. The judgement was wrong: they traded a
security default for a smoother first run, in a product whose entire purpose is putting
applications on the internet. Every other entry resolves that tension the other way, by shipping
the safe thing and explaining the caveat in the description.

**A correct investigation can still produce the wrong call, and nothing in the test suite has an
opinion about which way you resolved a trade-off.**
