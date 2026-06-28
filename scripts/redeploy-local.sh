#!/usr/bin/env bash
#
# redeploy-local.sh — Layer 1 of the stale-`dist/` prevention (task #1348).
#
# ONE mechanical command (`npm run redeploy`) that makes a local deploy either
# provably fresh or a hard, loud failure — never a silent stale success. It runs,
# in order:
#
#     pull  ->  install  ->  build (writes dist/.build-stamp for HEAD)
#           ->  restart the launchd job  ->  VERIFY freshness against the LIVE process
#
# Freshness is PROVEN against the running process + the git SHA, NOT a directory
# mtime (a dir mtime is fragile: false-PASS on `touch dist/`, false-FAIL on an
# in-place recompile). The verify asserts BOTH:
#   (a) the launchd service PID changed across the kickstart (it really restarted), AND
#   (b) the LIVE build-stamp SHA == `git rev-parse --short HEAD` (the running build
#       was compiled from the checked-out source).
# If either fails, the script exits NON-ZERO with a stale/freshness/mismatch keyword.
#
# macOS / launchd only (mirrors scripts/install-launchd.sh's require_macos guard).
#
# Configurable (env, never hardcoded):
#   REDEPLOY_SERVICE_TARGET   launchd service target (default gui/<uid>/com.monday-bot)
#   REDEPLOY_LOG_FILE         stdout log to read the live build-stamp from
#                             (default ~/Library/Logs/monday-bot.out.log)
#   REDEPLOY_RESTART_WAIT_S   seconds to wait for the bot to re-log after kickstart (default 15)
#   REDEPLOY_SKIP_PULL=1      skip `git pull`     (e.g. CI / offline redeploy)
#   REDEPLOY_SKIP_INSTALL=1   skip `npm ci`       (deps already present)
#
# Test seams for the `--verify` subcommand (no launchd, no mutation — proves AC-2):
#   REDEPLOY_EXPECTED_SHA     override the HEAD sha (default `git rev-parse --short HEAD`)
#   REDEPLOY_LIVE_SHA         override the live sha (default: parsed from the log file)
#   REDEPLOY_OLD_PID          service PID captured BEFORE the kickstart
#   REDEPLOY_NEW_PID          service PID captured AFTER  the kickstart
#
set -uo pipefail

LABEL="com.monday-bot"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if REPO_DIR="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null)"; then
    :
else
    REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

SERVICE_TARGET="${REDEPLOY_SERVICE_TARGET:-gui/$(id -u 2>/dev/null || echo 0)/${LABEL}}"
LOG_FILE="${REDEPLOY_LOG_FILE:-${HOME}/Library/Logs/monday-bot.out.log}"
RESTART_WAIT_S="${REDEPLOY_RESTART_WAIT_S:-15}"

die() {
    echo "ERROR: $*" >&2
    exit 1
}
note() { echo "  $*"; }

require_macos() {
    [ "$(uname -s)" = "Darwin" ] || die "redeploy is for macOS (launchd) only; on Linux use the PM2 path (see README)."
}

# Current short SHA of the checked-out source.
head_sha() {
    git -C "${REPO_DIR}" rev-parse --short HEAD 2>/dev/null
}

# PID of the launchd service, or empty when not loaded/running.
service_pid() {
    launchctl print "${SERVICE_TARGET}" 2>/dev/null \
        | sed -nE 's/^[[:space:]]*pid = ([0-9]+).*/\1/p' \
        | head -1
}

# Live build-stamp SHA, read from the most recent `build-stamp:` line in the log.
live_sha_from_log() {
    [ -f "${LOG_FILE}" ] || return 0
    sed -nE 's/^build-stamp: sha=([0-9a-f]+) .*/\1/p' "${LOG_FILE}" | tail -1
}

# --- VERIFY: prove the LIVE process carries the HEAD build (AC-2) --------------
# Pure logic over injectable inputs — NO launchctl, NO mutation, NO macOS guard.
# Exits 0 when fresh; non-zero with a stale/freshness/mismatch keyword otherwise.
verify_freshness() {
    local expected live old_pid new_pid
    expected="${REDEPLOY_EXPECTED_SHA:-$(head_sha)}"
    live="${REDEPLOY_LIVE_SHA:-$(live_sha_from_log)}"
    old_pid="${REDEPLOY_OLD_PID:-}"
    new_pid="${REDEPLOY_NEW_PID:-$(service_pid)}"

    [ -n "${expected}" ] || die "could not determine HEAD sha (git rev-parse --short HEAD)."

    # (a) the process actually restarted: a fresh PID after the kickstart.
    if [ -n "${old_pid}" ] && [ "${old_pid}" = "${new_pid}" ]; then
        die "freshness check FAILED — launchd PID did not change (${old_pid}); the live process did NOT restart. Rebuild + restart did not take effect."
    fi
    if [ -z "${new_pid}" ]; then
        die "freshness check FAILED — launchd service has no running PID after kickstart; the bot is not up. Investigate before trusting this deploy."
    fi

    # (b) the live build was compiled from the checked-out source.
    if [ -z "${live}" ]; then
        die "freshness check FAILED — no live build-stamp found; cannot prove the running build is fresh. Possible stale build (rebuild)."
    fi
    if [ "${live}" != "${expected}" ]; then
        die "freshness MISMATCH — live build-stamp sha=${live} != HEAD sha=${expected}. The running process is STALE; rebuild + restart did not land. (stale)"
    fi

    echo "Freshness PROVEN: live build-stamp sha=${live} == HEAD ${expected}; service PID=${new_pid} (restarted)."
}

# --- full mechanical redeploy -------------------------------------------------
cmd_redeploy() {
    require_macos
    echo "==> Redeploy: pull -> install -> build -> restart -> verify"

    if [ "${REDEPLOY_SKIP_PULL:-0}" = "1" ]; then
        note "[skip] git pull (REDEPLOY_SKIP_PULL=1)"
    else
        echo "==> git pull"
        git -C "${REPO_DIR}" pull --ff-only || die "git pull failed — resolve before redeploying."
    fi

    if [ "${REDEPLOY_SKIP_INSTALL:-0}" = "1" ]; then
        note "[skip] npm ci (REDEPLOY_SKIP_INSTALL=1)"
    else
        echo "==> npm ci"
        ( cd "${REPO_DIR}" && npm ci ) || die "npm ci failed — resolve before redeploying."
    fi

    # Capture the live PID BEFORE we restart, so the verify can prove it changed.
    local old_pid
    old_pid="$(service_pid)"
    echo "==> pre-restart launchd PID: ${old_pid:-<not running>}"

    echo "==> npm run build (Layer 1 OWNS this build; writes dist/.build-stamp for HEAD)"
    ( cd "${REPO_DIR}" && npm run build ) || die "build (tsc) FAILED — NOT restarting the bot; it keeps serving the previous build. Fix the build, then redeploy."

    echo "==> launchctl kickstart -k ${SERVICE_TARGET}"
    launchctl kickstart -k "${SERVICE_TARGET}" || die "launchctl kickstart failed — is the agent installed? (bash scripts/install-launchd.sh)"

    echo "==> waiting up to ${RESTART_WAIT_S}s for the bot to re-log its build-stamp"
    local expected new_pid live i
    expected="$(head_sha)"
    for (( i = 0; i < RESTART_WAIT_S; i++ )); do
        sleep 1
        new_pid="$(service_pid)"
        live="$(live_sha_from_log)"
        if [ -n "${new_pid}" ] && [ "${new_pid}" != "${old_pid}" ] && [ "${live}" = "${expected}" ]; then
            break
        fi
    done

    echo "==> verifying LIVE freshness"
    REDEPLOY_OLD_PID="${old_pid}" REDEPLOY_NEW_PID="${new_pid:-$(service_pid)}" \
        REDEPLOY_EXPECTED_SHA="${expected}" REDEPLOY_LIVE_SHA="${live:-$(live_sha_from_log)}" \
        verify_freshness

    echo "==> Redeploy complete — the live bot is provably running the HEAD build."
}

usage() {
    cat <<EOF
redeploy-local.sh — one mechanical, fresh-or-fail local redeploy (macOS/launchd).

  (no args)   pull -> install -> build -> restart -> verify-or-fail.
  --verify    run ONLY the live-freshness check (no mutation); used by tests + ad-hoc audits.
  --help, -h  this help.

Wired as: npm run redeploy
EOF
}

main() {
    case "${1:-redeploy}" in
        redeploy | "") cmd_redeploy ;;
        --verify) verify_freshness ;;
        --help | -h) usage ;;
        *) usage; die "unknown argument: $1" ;;
    esac
}

main "$@"
