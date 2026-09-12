#!/usr/bin/env bash
#
# Pushes the working tree to the hot-reload dev deployment (compose.dev.yaml) over SSH, so
# its bind-mounted /app picks up the change without a rebuild. Safe to run repeatedly: rsync
# only transfers what changed, and the excludes below keep it from clobbering state that
# belongs to the running container rather than to the repo — its node_modules and data live
# in named volumes, not in the working tree, but excluding them here too means an accidental
# local node_modules/data directory never gets shipped either.
#
# Destination is overridable, not hardcoded to one box:
#   HOMESTEAD_TEST_HOST=other-host HOMESTEAD_TEST_PATH=/opt/homestead ./scripts/push-to-test.sh
#
# Defaults point at this project's current Tailscale test VM.

set -euo pipefail

HOST="${HOMESTEAD_TEST_HOST:-homestead-test.hippo-ule.ts.net}"
DEST_PATH="${HOMESTEAD_TEST_PATH:-/opt/homestead}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Pushing $REPO_ROOT to $HOST:$DEST_PATH"

rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'data' \
  --exclude '.superpowers' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  --exclude '.vite' \
  --exclude 'coverage' \
  "$REPO_ROOT"/ "$HOST:$DEST_PATH"/

echo "==> Pushed. The container's watchers (tsx watch, Vite) pick this up on their own."
echo "==> If Dockerfile.dev, package.json's dependencies, or compose.dev.yaml changed, rebuild instead:"
echo "    ssh $HOST 'cd $DEST_PATH && docker compose -f compose.dev.yaml up -d --build'"
