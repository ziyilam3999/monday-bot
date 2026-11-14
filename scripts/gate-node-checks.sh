#!/usr/bin/env bash
# Gate check for code paths (src, tests, config, build files): runs the same checks CI runs, OFFLINE.
#   typecheck (tsc --noEmit for src and tests), build (tsc -> dist, dist/index.js must exist), jest, plus
#   `bash -n` on every tracked shell script and `node --check` on every tracked scripts/*.js.
# Assumption: node_modules is present. This gate NEVER runs npm install/ci (no network). If node_modules is
# missing it FAILS (exit 1) with a clear line, it never passes by skipping. The one convenience: when the gate
# runs in a fresh clone of a ticket tree (origin = that tree), a node_modules folder or link next to it is
# linked in, because a fresh clone has none.
# Exit 0 = all pass. Exit 1 = the first failing step, named on stderr.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -e node_modules ]; then
  origin=$(git remote get-url origin 2>/dev/null || true)
  case "$origin" in
    /*) if [ -d "$origin/node_modules" ]; then ln -s "$origin/node_modules" node_modules; fi ;;
  esac
fi
if [ ! -d node_modules ] || [ ! -x node_modules/.bin/tsc ] || [ ! -x node_modules/.bin/jest ]; then
  echo "node-checks: FAIL: node_modules (with tsc and jest) is missing; this gate is offline and never installs" >&2
  exit 1
fi

step() {
  local name=$1; shift
  if ! "$@" >&2; then
    echo "node-checks: FAIL: $name" >&2
    exit 1
  fi
}

step typecheck npm run --silent typecheck
step build npm run --silent build
[ -f dist/index.js ] || { echo "node-checks: FAIL: dist/index.js missing after build" >&2; exit 1; }
step jest npm test --silent

while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    *.sh) step "bash -n $f" bash -n "$f" ;;
    scripts/*.js) step "node --check $f" node --check "$f" ;;
  esac
done < <(git ls-files scripts)

echo "node-checks: ok"
