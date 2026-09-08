# Homestead

A self-hosted web UI for managing Docker Compose stacks on your NAS.

## Install

Pull the image and run it with Docker Compose:

```bash
docker compose up -d
```

Example `compose.yaml`:

```yaml
services:
  homestead:
    image: ghcr.io/<owner>/homestead:latest
    # Host networking is required so health probes reach services at 127.0.0.1.
    # A bridged container's loopback is its own, so tcp/http checks would test
    # the container instead of the service, and every app would report down.
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

Replace `<owner>` with your GitHub username or organization name.

## Critical Configuration Requirements

### 1. Host networking is required

**Use `network_mode: host` in your compose file.** Bridged networking makes every local health probe fail because the container's loopback interface is isolated. Apps will show as down even when they're running correctly, and the configuration will look perfectly correct. This symptom points at the apps rather than the networking, making it expensive to diagnose.

### 2. Data directory must be on local storage

**`$HOMESTEAD_DATA` must be on local storage, not NFS or SMB.** SQLite's file locking is unreliable on network filesystems and the database will corrupt silently. You won't know until history queries fail or the icon cache breaks.

### 3. Data directory must persist

**`$HOMESTEAD_DATA` must be a persistent volume.** Otherwise all history and the icon cache are lost on every container restart.

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HOMESTEAD_DATA` | No | `/var/lib/homestead` | Absolute path to data directory (SQLite database, icon cache). Must be on local storage and persistent. |
| `HOMESTEAD_PROJECTS` | No | `/opt/stacks` | Absolute path to directory containing compose projects inside the container. |
| `HOMESTEAD_PROJECTS_HOST` | No | Same as `HOMESTEAD_PROJECTS` | Absolute path to compose projects on the host. Used to translate container paths to host paths for `docker compose` commands. |
| `HOMESTEAD_WEB_DIR` | No | None (uses bundled build) | Absolute path to custom web UI build directory. Only needed for development. |
| `PORT` | No | `7420` | HTTP server port (1-65535). |
| `HOMESTEAD_SECRET_KEY` | No | Auto-generated | Secret key for session signing. Auto-generated on first start and persisted to the database. Set explicitly for multi-instance deployments. |
| `HOMESTEAD_BASE_URL` | No | `http://localhost:{PORT}` | Public URL where Homestead is accessed. Used for auth cookie settings. Format: `scheme://host[:port]` with no path. |
| `HOMESTEAD_TRUSTED_ORIGINS` | No | None | Comma-separated list of allowed origins for CORS. Format: `scheme://host[:port]` with no path. Do not use `*`. |

## Startup Checks

On startup, Homestead runs preflight checks for common configuration issues:

- Docker socket access
- Data directory filesystem type (warns if on network storage)
- Compose projects directory existence and permissions

If any checks fail, the server still starts but displays a warning banner in the UI. The banner is intentional — it's telling you about a configuration issue, not a bug.

## License

MIT
