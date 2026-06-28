#!/usr/bin/env bash
#
# launchd-wrapper.sh — Layer 3 of the stale-`dist/` prevention (task #1348).
#
# launchd no longer execs `node dist/index.js` directly. It execs THIS wrapper,
# which on every (re)launch:
#
#   1. SKIP-WHEN-FRESH-FOR-HEAD: if dist/.build-stamp SHA == `git rev-parse --short HEAD`
#      the dist is already compiled for the checked-out source (e.g. a Layer-1
#      redeploy just built it) -> skip the rebuild, promote dist -> last-good, exec node.
#   2. Otherwise BUILD. If GREEN -> promote dist -> last-good, exec the fresh node.
#      If the build FAILS:
#        - last-good present -> log loudly, exec node from the LAST-GOOD dist
#          (a bad build NEVER takes the team bot down).
#        - NO last-good (cold start) -> emit the fixed cold-fail line, increment
#          dist/.cold-fail-count, sleep a bounded backoff (so KeepAlive +
#          ThrottleInterval can't tight-spin it), then exit non-zero.
#
# EXIT-CODE ISOLATION (the load-bearing safety property): on every path that runs
# the bot the wrapper `exec`s node, so the wrapper PROCESS IS REPLACED by node and
# `wrapper-exit == node-exit` BY CONSTRUCTION — never the build's status. A naive
# `build; node …; exit $build_rc` would, under KeepAlive, return the build's
# non-zero on the next clean bot exit and crash-loop the bot. That antipattern is
# FORBIDDEN here. (`set -e` is deliberately NOT used for the same reason.)
#
# PUBLIC repo: this file carries NO real paths/hostnames/tokens — everything is
# derived at runtime from the wrapper's own location ($0) and $HOME.
#
# Configurable (env, never hardcoded constants):
#   COLD_FAIL_BACKOFF_BASE   base backoff seconds (default 10)
#   COLD_FAIL_BACKOFF_MAX    backoff ceiling seconds (default 300)
#   COLD_FAIL_MAX_RETRIES    informational cap on consecutive cold failures (default 5)
# Test seams (so AC-7/8/9/10 are provable without launchd):
#   WRAPPER_REPO_DIR         repo root (default: derived from $0)
#   WRAPPER_DIST_DIR         dist dir (default <repo>/dist)
#   WRAPPER_LAST_GOOD_DIR    last-good dist dir (default <repo>/dist-last-good)
#   WRAPPER_BUILD_CMD        build command (default "npm run build"); set to a
#                            failing command to exercise the fallback paths
#   WRAPPER_NODE             node binary (default: `command -v node`)
#   WRAPPER_HEAD_SHA         override HEAD sha (default `git rev-parse --short HEAD`)
#
set -uo pipefail

# --- resolve locations from $0 (no baked paths) -------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${WRAPPER_REPO_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
DIST_DIR="${WRAPPER_DIST_DIR:-${REPO_DIR}/dist}"
LAST_GOOD_DIR="${WRAPPER_LAST_GOOD_DIR:-${REPO_DIR}/dist-last-good}"
BUILD_CMD="${WRAPPER_BUILD_CMD:-npm run build}"
NODE_BIN="${WRAPPER_NODE:-$(command -v node || true)}"

COLD_FAIL_BACKOFF_BASE="${COLD_FAIL_BACKOFF_BASE:-10}"
COLD_FAIL_BACKOFF_MAX="${COLD_FAIL_BACKOFF_MAX:-300}"
COLD_FAIL_MAX_RETRIES="${COLD_FAIL_MAX_RETRIES:-5}"

COLD_FAIL_LINE="build-stamp: COLD-START FAILURE — no last-good dist and build failed; cannot start"

log() { echo "launchd-wrapper: $*"; }

head_sha() {
    if [ -n "${WRAPPER_HEAD_SHA:-}" ]; then
        echo "${WRAPPER_HEAD_SHA}"
        return 0
    fi
    git -C "${REPO_DIR}" rev-parse --short HEAD 2>/dev/null
}

stamp_sha() {
    local f="${1}/.build-stamp"
    [ -f "${f}" ] || return 0
    sed -nE 's/^sha=([0-9a-f]+) .*/\1/p' "${f}" | head -1
}

# Copy a built dist to last-good. Only ever called AFTER a green build / verified
# skip, so last-good is always a previously-working artifact (never a failed build).
promote_last_good() {
    [ -f "${DIST_DIR}/index.js" ] || return 0
    rm -rf "${LAST_GOOD_DIR}.tmp" 2>/dev/null || true
    cp -R "${DIST_DIR}" "${LAST_GOOD_DIR}.tmp" || { log "WARNING: could not snapshot last-good"; return 0; }
    rm -rf "${LAST_GOOD_DIR}" 2>/dev/null || true
    mv "${LAST_GOOD_DIR}.tmp" "${LAST_GOOD_DIR}"
}

# Replace this wrapper process with node (PID-reuse) so wrapper-exit == node-exit.
exec_node() {
    local entry="$1"
    [ -n "${NODE_BIN}" ] || { log "FATAL: node not found on PATH; cannot start."; exit 127; }
    # Reset the cold-fail counter on any successful start.
    rm -f "${DIST_DIR}/.cold-fail-count" 2>/dev/null || true
    log "exec ${entry}"
    exec "${NODE_BIN}" "${entry}"
}

# Bounded backoff for the nth consecutive cold failure: min(BASE*2^(n-1), MAX).
cold_fail_backoff_secs() {
    local n="$1" secs
    secs=$(( COLD_FAIL_BACKOFF_BASE * (1 << (n - 1)) ))
    if [ "${secs}" -gt "${COLD_FAIL_BACKOFF_MAX}" ]; then
        secs="${COLD_FAIL_BACKOFF_MAX}"
    fi
    echo "${secs}"
}

cold_start_failure() {
    mkdir -p "${DIST_DIR}"
    local n
    n=$(( $(cat "${DIST_DIR}/.cold-fail-count" 2>/dev/null || echo 0) + 1 ))
    echo "${n}" > "${DIST_DIR}/.cold-fail-count"

    # The fixed, loud, grep-able cold-fail line (build-stamp contract).
    echo "${COLD_FAIL_LINE}"
    log "consecutive cold failures: ${n} (max ${COLD_FAIL_MAX_RETRIES})"

    local backoff
    backoff="$(cold_fail_backoff_secs "${n}")"
    log "bounded backoff: sleeping ${backoff}s before exit so KeepAlive cannot tight-spin"
    sleep "${backoff}"
    exit 1
}

run() {
    local head dsha

    head="$(head_sha)"
    dsha="$(stamp_sha "${DIST_DIR}")"

    # 1. Skip-when-fresh-for-HEAD — the dist is already the checked-out source.
    if [ -n "${head}" ] && [ -n "${dsha}" ] && [ "${dsha}" = "${head}" ]; then
        log "dist is fresh for HEAD (${head}) — skipping rebuild."
        promote_last_good
        exec_node "${DIST_DIR}/index.js"
    fi

    # 2. Build.
    log "building (${BUILD_CMD}) — dist stamp '${dsha:-none}' != HEAD '${head:-unknown}'"
    local build_rc
    ( cd "${REPO_DIR}" && eval "${BUILD_CMD}" ); build_rc=$?

    if [ "${build_rc}" -eq 0 ] && [ -f "${DIST_DIR}/index.js" ]; then
        log "build GREEN — promoting last-good and starting fresh dist."
        promote_last_good
        exec_node "${DIST_DIR}/index.js"
    fi

    # 3a. Build FAILED but a last-good dist exists -> serve it (loud), never the
    #     build's non-zero. The wrapper still `exec`s node, so exit == node's.
    if [ -f "${LAST_GOOD_DIR}/index.js" ]; then
        log "BUILD FAILED (rc=${build_rc}) — falling back to LAST-GOOD dist. A bad build must NOT take the bot down."
        exec_node "${LAST_GOOD_DIR}/index.js"
    fi

    # 3b. Cold start: build failed AND no last-good -> bounded, loud failure.
    log "BUILD FAILED (rc=${build_rc}) and NO last-good dist available."
    cold_start_failure
}

run
