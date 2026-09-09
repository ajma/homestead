# Homestead

A self-hosted web UI for running Docker Compose projects on a home server, watching whether they are up, and publishing them on real hostnames.

## Language

### Projects and apps

**Project**:
A directory under the projects directory holding a Compose file. The unit that is started, stopped and deleted.
_Avoid_: stack, deployment

**Slug**:
A project's directory name, and the name Compose reconciles it by. A project's permanent identity.

**Service**:
One entry under `services:` in a project's Compose file. Not everything that runs is an app.

**App**:
A service that publishes a host port, or a manually recorded URL. The unit a dashboard tile represents, keyed `<slug>:<service>` or `manual:<id>`.

**Manual app**:
An app that is only a name and a URL, with no project behind it. Recorded when something worth watching is not run by Homestead.

**Identity**:
A project's presentation — display name, description, icon. It belongs to the project, so every app of a project shows the same one.

### Publishing

**Exposure**:
A mapping from a host port to a public hostname, served through the Cloudflare tunnel. Keyed by port, never by service name.
_Avoid_: tunnel, ingress, route

**Hostname**:
The public DNS name an exposure answers on. Also what makes an app's public checks possible.

**Access**:
Cloudflare's authentication layer in front of an exposure. What a visitor signs in to, and what the probe presents a service token to bypass.

### Monitoring

**Target**:
The thing that carries a status dot — a device or an app. The level at which "is it up" is answered.

**Monitor**:
One recurring check defined against a target. A device's are set by hand; an app's are derived from its Compose file and its exposure, and cannot be added to.

**Check**:
One execution of one monitor: up or down, at a time, with an error if it failed.

**Required**:
A monitor whose failure turns its target's dot red. The opposite is **advisory** — recorded and shown, but unable to change the dot.

**Tier**:
The confidence label a tile carries alongside its dot: how much is known about the app, not just whether it answered.

**Rollup**:
Hourly up and down counts, kept after the individual checks behind them are pruned. What long-range uptime is read from.

**Device**:
A machine on the tailnet, or one recorded by hand. A target that Homestead watches but does not run.

### Lifecycle

**Operation**:
One run of a lifecycle verb against a project, with its output, exit code and duration. What the log panel shows and the history lists.

**Lifecycle verb**:
Something done to a running project: start, stop, restart, pull. Removal is not one — it belongs to deleting the project.
