#!/usr/bin/env bash
#
# post-merge-hook-smoke.sh — hermetic behavioral smoke for
# scripts/git-hooks/post-merge (#1372). Driven by the win32-skipped jest wrapper
# tests/post-merge-hook.test.ts, which prepends the launchctl SHIM dir
# (tests/fixtures/launchctl-shim) to PATH — so `launchctl` here is the shim, NOT
# the system binary. There is ZERO launchctl logic in any TS file; the wrapper
# only shells out and asserts this script's exit code.
#
# It drives the hook with env-injected inputs (service target + change set) so
# every assertion is observable from OUTSIDE the implementation, and proves the
# three contract cases:
#   1. job ABSENT + source changed   -> NO-OP: exit 0, no kickstart, no stderr.
#   2. job LOADED + non-source only   -> NO-OP: exit 0, no kickstart.
#   3. job LOADED + source advanced   -> EXACTLY ONE kickstart, exit 0.
#
# `readlink -f "$0"` self-location is NOT exercised here (env-injected inputs);
# it is the macOS-install-path concern noted in the hook header.
#
set -uo pipefail

SMOKE_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
SMOKE_DIR="$(cd "$(dirname "${SMOKE_PATH}")" && pwd)"
REPO_DIR="$(cd "${SMOKE_DIR}/.." && pwd)"
HOOK="${REPO_DIR}/scripts/git-hooks/post-merge"

fail() { echo "post-merge smoke: $*" >&2; }

[ -f "${HOOK}" ] || { fail "FAIL — hook not found at ${HOOK}"; exit 1; }

# The launchctl on PATH MUST be the shim (the wrapper guarantees this); if the
# real binary were resolved, a not-loaded job would falsely look the same — but
# a kickstart would hit the real launchctl. Guard against a mis-wired PATH.
command -v launchctl >/dev/null 2>&1 || { fail "FAIL — no launchctl shim on PATH"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
CALL_LOG="${WORK}/calls.log"
ERR_LOG="${WORK}/stderr.log"
TARGET="gui/0/com.monday-bot.test"

# run_hook <job-loaded 0|1> <changed-files newline-sep> -> prints the hook exit code
run_hook() {
  : >"${CALL_LOG}"
  : >"${ERR_LOG}"
  SHIM_JOB_LOADED="$1" \
  SHIM_CALL_LOG="${CALL_LOG}" \
  POST_MERGE_SERVICE_TARGET="${TARGET}" \
  POST_MERGE_CHANGED_FILES="$2" \
    bash "${HOOK}" 1 >/dev/null 2>"${ERR_LOG}"
  echo "$?"
}

kick_count() { grep -c '^kickstart' "${CALL_LOG}" 2>/dev/null || true; }

fails=0

# --- Case 1: job ABSENT + source changed -> clean NO-OP (no stderr) -----------
rc="$(run_hook 0 "src/index.ts")"
[ "${rc}" = "0" ] || { fail "Case1 FAIL — exit ${rc} != 0"; fails=1; }
[ "$(kick_count)" = "0" ] || { fail "Case1 FAIL — kickstart fired while job ABSENT"; fails=1; }
[ -s "${ERR_LOG}" ] && { fail "Case1 FAIL — wrote to stderr while job ABSENT"; fails=1; }

# --- Case 2: job LOADED + only non-source changed -> NO-OP --------------------
rc="$(run_hook 1 "README.md
tests/foo.test.ts
.ai-workspace/notes.md")"
[ "${rc}" = "0" ] || { fail "Case2 FAIL — exit ${rc} != 0"; fails=1; }
[ "$(kick_count)" = "0" ] || { fail "Case2 FAIL — kickstart fired for non-source change"; fails=1; }

# --- Case 3: job LOADED + source advanced -> exactly ONE kickstart ------------
rc="$(run_hook 1 "README.md
src/index.ts")"
[ "${rc}" = "0" ] || { fail "Case3 FAIL — exit ${rc} != 0"; fails=1; }
[ "$(kick_count)" = "1" ] || { fail "Case3 FAIL — expected 1 kickstart, got $(kick_count)"; fails=1; }

if [ "${fails}" -ne 0 ]; then
  fail "FAIL"
  exit 1
fi
echo "post-merge smoke: PASS (3/3 cases)"
exit 0
