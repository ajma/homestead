#!/bin/sh
# Entrypoint for the hot-reload deployment (compose.dev.yaml).
set -eu

# The bind mount at /app hides anything a build step might otherwise have installed, so
# install here instead, into the node_modules named volume. Warm starts (the volume already
# populated) are a fast no-op thanks to the frozen lockfile.
echo "==> pnpm install"
pnpm install --frozen-lockfile

# exec, not a backgrounded run: this shell is replaced by pnpm/concurrently, so signals
# (`docker compose down`, `docker compose restart`) reach the actual server and Vite
# processes directly instead of stopping only a wrapper around them.
#
# We run the repo's own `pnpm dev` rather than hand-rolling a `wait -n` (as an earlier
# attempt at this did) because package.json's dev script now carries concurrently's
# --kill-others-on-fail: the moment either the server or Vite dies, the other is killed and
# concurrently exits non-zero. That gives local development the same behaviour as this
# container, rather than the container behaving differently from how a developer runs it —
# and it means this script does not sit there half-running and looking healthy if one half
# has died.
echo "==> pnpm dev"
exec pnpm dev
