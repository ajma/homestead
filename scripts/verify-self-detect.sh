#!/usr/bin/env bash
#
# Manual verification gate for self-detect.ts's core mechanism
# (`extractSelfContainerId` + `detectSelfDirectory`), run against a REAL Docker daemon
# rather than a fake `Host` — see the Phase 2F whole-branch review's F1 for the defect
# this exists to catch: `self-detect.ts` used to read `$HOSTNAME`, which every unit test
# fed a synthetic value chosen to match a fixture container id, and which is the HOST's
# hostname (not the container's) under `network_mode: host` — the exact networking mode
# `compose.example.yaml` mandates for Homestead's own deployment. That defect survived
# every unit test because no test ever put a genuine `network_mode: host` container in
# front of the detection logic. This script does.
#
# WHY THIS EXISTS RATHER THAN ONLY A UNIT TEST: `self-detect.test.ts` exercises the
# mountinfo parser against text captured from a real daemon, but that is a frozen
# fixture — it cannot prove the CURRENT code still agrees with what a real `docker
# compose` container's mount table and `listContainers()` look like today, on whatever
# Docker version is actually installed. This script runs the real, unmodified
# `detectSelfDirectory` (imported straight from `src/server/apps/self-detect.ts` — the
# same file `routes/apps.ts` calls in production, not a reimplementation) inside a real
# container, under `network_mode: host`, against the real Docker socket, four different
# ways a compose stack can sit relative to a compose root. Same precedent as
# `scripts/verify-mount-preflight.sh`: a manual gate that actually runs beats an
# automated test that structurally cannot reach the branch in question.
#
# Requires Docker and the `node:24-alpine` image (pulled automatically if missing) —
# nothing else. Uses Node's built-in TypeScript type-stripping (stable since Node 23.6)
# so `self-detect-probe.mjs` runs `self-detect.ts` with no build step.
#
# Run by hand before a release that touches `self-detect.ts`, `routes/apps.ts`'s adopt
# path, or `compose.example.yaml`'s networking. Every container and temp directory this
# script creates is removed on exit, success or failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${HOMESTEAD_VERIFY_NODE_IMAGE:-node:24-alpine}"
PASS=0
FAIL=0

TMP_ROOTS=()
COMPOSE_PROJECTS=()

cleanup() {
  for p in "${COMPOSE_PROJECTS[@]:-}"; do
    [ -n "$p" ] && docker compose -p "$p" down -v >/dev/null 2>&1 || true
  done
  for d in "${TMP_ROOTS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d" || true
  done
}
trap cleanup EXIT

mkroot() {
  mktemp -d "${TMPDIR:-/tmp}/hs-self-detect-verify.XXXXXX"
}

# Runs the real detection pipeline inside a container started by a real `docker compose
# up` from `$stack_dir` — so `com.docker.compose.project.working_dir` is whatever
# Docker Compose itself stamps, not a value this script injects — under
# `network_mode: host`, and checks the result against `$expect` ("null" for no match, or
# the expected relative directory).
run_case() {
  local label="$1" stack_dir="$2" compose_root="$3" expect="$4"
  local project="hsselfdetectverify$$$RANDOM"
  COMPOSE_PROJECTS+=("$project")

  cat >"$stack_dir/compose.yml" <<YAML
services:
  probe:
    image: ${IMAGE}
    network_mode: host
    working_dir: ${REPO_ROOT}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${REPO_ROOT}:${REPO_ROOT}:ro
    command: ["node", "--experimental-strip-types", "${REPO_ROOT}/scripts/self-detect-probe.mjs", "${compose_root}"]
YAML

  local output
  set +e
  output=$(cd "$stack_dir" && docker compose -p "$project" run --rm probe 2>&1)
  local status=$?
  set -e

  if [ "$status" -ne 0 ]; then
    echo "FAIL: $label (probe exited $status)"
    echo "$output" | sed 's/^/  /'
    FAIL=$((FAIL + 1))
    return
  fi

  if echo "$output" | grep -qx "SELF_DIRECTORY=$expect"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected SELF_DIRECTORY=$expect)"
    echo "$output" | sed 's/^/  /'
    FAIL=$((FAIL + 1))
  fi
}

echo "== A subdirectory of the compose root, one level deep (the shipped layout) =="
ROOT1=$(mkroot); TMP_ROOTS+=("$ROOT1")
mkdir -p "$ROOT1/homestead"
run_case "one level deep" "$ROOT1/homestead" "$ROOT1" "homestead"

echo "== A subdirectory of the compose root, two levels deep =="
ROOT2=$(mkroot); TMP_ROOTS+=("$ROOT2")
mkdir -p "$ROOT2/infra/homestead"
run_case "two levels deep" "$ROOT2/infra/homestead" "$ROOT2" "infra/homestead"

echo "== The stack's own directory IS the compose root =="
ROOT3=$(mkroot); TMP_ROOTS+=("$ROOT3")
run_case "working dir is the compose root itself" "$ROOT3" "$ROOT3" "null"

echo "== The stack sits outside the compose root entirely =="
ROOT4=$(mkroot); TMP_ROOTS+=("$ROOT4")
OTHER4=$(mkroot); TMP_ROOTS+=("$OTHER4")
run_case "outside the compose root" "$OTHER4" "$ROOT4" "null"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
