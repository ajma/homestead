#!/usr/bin/env bash
#
# Manual verification gate for src/server/host/preflight.ts's decisive line
# (`if (!output.includes(token))`).
#
# WHY THIS EXISTS RATHER THAN A UNIT TEST: preflight.test.ts's own NOTE ON COVERAGE
# explains that the branch this check exists for — the compose root being writable from
# where the test runs but resolving to a DIFFERENT directory on the Docker host — cannot
# be exercised from a test process that IS the host. It is only reachable when Homestead
# itself runs containerised with a mismatched bind mount, which is what this script sets
# up. Mutating the line to `if (false)` leaves all 7 automated preflight tests green (see
# the 1H whole-branch review, Minor finding on preflight.ts:121); this script is the
# thing that actually exercises the branch those tests cannot reach.
#
# Run by hand before a release that touches src/server/host/preflight.ts, or after
# changing the Dockerfile/compose.example.yaml volumes. Requires Docker. Builds nothing;
# it assumes `homestead:dev` already exists (`docker build -t homestead:dev .`).
#
# Every container, volume and temp directory this script creates is removed on exit,
# success or failure.

set -euo pipefail

IMAGE="${HOMESTEAD_IMAGE:-homestead:dev}"
PASS=0
FAIL=0

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "error: image '$IMAGE' not found. Build it first: docker build -t $IMAGE ." >&2
  exit 2
fi

CONTAINERS=()
DIRS=()

cleanup() {
  for c in "${CONTAINERS[@]:-}"; do
    [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true
  done
  for d in "${DIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d" || true
  done
}
trap cleanup EXIT

mkroot() {
  mktemp -d "${TMPDIR:-/tmp}/hs-preflight-verify.XXXXXX"
}

# Runs homestead:dev with the given compose-root bind mount and HOMESTEAD_COMPOSE_ROOT,
# and reports whether the preflight refused to start (expected exit 1, PreflightError in
# the log) within a short timeout. Does not wait for full boot — the preflight runs
# before migrations, so a refusal is fast.
expect_refused() {
  local label="$1" bind="$2" compose_root="$3"
  local name="hs-preflight-verify-$$-$RANDOM"
  CONTAINERS+=("$name")

  local bind_args=()
  [ -n "$bind" ] && bind_args=(-v "$bind")

  set +e
  docker run --name "$name" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    "${bind_args[@]}" \
    -e "HOMESTEAD_COMPOSE_ROOT=$compose_root" \
    -e HOMESTEAD_SECRET_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" \
    -e HOMESTEAD_BASE_URL="http://localhost:3000" \
    "$IMAGE" >/tmp/hs-preflight-verify.log 2>&1
  local status=$?
  set -e

  if [ "$status" -ne 0 ] && grep -qi "PreflightError\|preflight" /tmp/hs-preflight-verify.log; then
    echo "PASS: $label (refused, exit $status)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected a refused PreflightError exit; got exit $status)"
    echo "  --- log ---"
    sed 's/^/  /' /tmp/hs-preflight-verify.log
    FAIL=$((FAIL + 1))
  fi
}

# Runs homestead:dev with a CORRECT identity-mapped mount and reports whether it got past
# the preflight (i.e. did NOT exit with a PreflightError in the first few seconds).
expect_passes_preflight() {
  local label="$1" bind="$2" compose_root="$3"
  local name="hs-preflight-verify-$$-$RANDOM"
  CONTAINERS+=("$name")

  docker run -d --name "$name" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$bind" \
    -e "HOMESTEAD_COMPOSE_ROOT=$compose_root" \
    -e HOMESTEAD_SECRET_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" \
    -e HOMESTEAD_BASE_URL="http://localhost:3000" \
    "$IMAGE" >/dev/null

  sleep 5
  if docker logs "$name" 2>&1 | grep -qi "PreflightError"; then
    echo "FAIL: $label (preflight refused a correctly mounted root)"
    docker logs "$name" 2>&1 | sed 's/^/  /'
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $label (preflight let it through)"
    PASS=$((PASS + 1))
  fi
}

ROOT=$(mkroot); DIRS+=("$ROOT")
OTHER=$(mkroot); DIRS+=("$OTHER")

echo "== Correct: identical path on both sides =="
expect_passes_preflight "correct mount" "$ROOT:$ROOT" "$ROOT"

echo "== Different container path =="
expect_refused "container path mismatch" "$ROOT:/data" "$ROOT"

echo "== Container path exists on host but is a different directory =="
expect_refused "different host directory" "$ROOT:$OTHER" "$OTHER"

echo "== No compose-root mount at all =="
expect_refused "missing mount" "" "$ROOT"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
