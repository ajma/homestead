#!/bin/sh
# Starts Homestead in watch mode: Vite serves the UI with HMR and proxies /api
# to the server, which tsx restarts whenever a file under src/server changes.
set -eu

# The bind mount hides anything installed during the image build, so install
# here into the node_modules volume. Warm starts are a fast no-op.
echo "==> pnpm install"
pnpm install --frozen-lockfile

# Not `pnpm dev`: that script pins HOMESTEAD_TRUSTED_ORIGINS to localhost:5173
# inline, and an inline assignment beats the environment. Reaching this box from
# another machine needs the real origin, which compose.dev.yaml supplies.
echo "==> vite on 5173, server on ${PORT:-7420}"
pnpm exec vite --host 0.0.0.0 &
vite_pid=$!

# Hand signals to both, so `docker compose down` does not leave a stray watcher.
trap 'kill "$vite_pid" 2>/dev/null || true' INT TERM

pnpm exec tsx watch src/server/index.ts &
server_pid=$!

# Exit as soon as either half dies, rather than sitting there half-running and
# looking healthy.
wait -n "$vite_pid" "$server_pid"
kill "$vite_pid" "$server_pid" 2>/dev/null || true
exit 1
