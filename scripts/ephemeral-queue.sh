#!/usr/bin/env bash
# Cross-agent serializer for `yarn test:integration:ephemeral`.
#
# When multiple parallel agents (worktrees) all run ephemeral integration tests
# at once, the laptop spins up N Postgres containers + N Next.js dev servers.
# Even with --no-reuse-env (which avoids port + state-file collision), the raw
# memory + CPU footprint can saturate the host.
#
# This wrapper acquires an atomic mkdir-lock at /tmp/om-prm-ephemeral.lock so
# only one ephemeral environment runs at a time across the whole machine.
# Worktrees serialize, but each still gets its own isolated Postgres + port.
#
# Usage (from any worktree's package.json or shell):
#   bash scripts/ephemeral-queue.sh -- --grep "TC-PRM-T5-001"
#
# Or update package.json scripts to:
#   "test:integration:ephemeral:queued": "bash scripts/ephemeral-queue.sh"
#
# All args after `--` are forwarded to `yarn test:integration:ephemeral`.

set -euo pipefail

LOCK_DIR="${OM_EPHEMERAL_LOCK_DIR:-/tmp/om-prm-ephemeral.lock}"
WAIT_INTERVAL_S="${OM_EPHEMERAL_LOCK_POLL_S:-15}"
WAIT_TIMEOUT_S="${OM_EPHEMERAL_LOCK_TIMEOUT_S:-3600}"

elapsed=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  if [ "$elapsed" -ge "$WAIT_TIMEOUT_S" ]; then
    echo "[ephemeral-queue] Timed out after ${WAIT_TIMEOUT_S}s waiting for $LOCK_DIR" >&2
    exit 1
  fi
  if [ "$elapsed" -eq 0 ]; then
    echo "[ephemeral-queue] $LOCK_DIR is held; waiting (poll every ${WAIT_INTERVAL_S}s, timeout ${WAIT_TIMEOUT_S}s)..." >&2
  fi
  sleep "$WAIT_INTERVAL_S"
  elapsed=$((elapsed + WAIT_INTERVAL_S))
done

trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

echo "[ephemeral-queue] Lock acquired at $LOCK_DIR (waited ${elapsed}s). Starting ephemeral run."
yarn test:integration:ephemeral --no-reuse-env "$@"
