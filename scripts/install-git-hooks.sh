#!/usr/bin/env bash
#
# install-git-hooks.sh — wire the LOCAL pre-commit privacy hook (#1222 Leg 2).
#
# Mirrors install-launchd.sh (tracked bash installer, public-safe, NO real paths —
# only a clone-relative tracked dir). monday-bot has NO auto-install path (no husky,
# no package.json prepare/postinstall), so the operator runs this ONCE per clone; the
# hook is NOT live until then (same honesty note as ai-brain's setup.sh).
#
# It points git at the TRACKED hooks dir scripts/git-hooks via core.hooksPath, so the
# tracked pre-commit (scripts/git-hooks/pre-commit) runs before every commit. The
# value written is the clone-RELATIVE path, so no absolute home path lands in
# .git/config — and it stays portable across clones.
#
# Usage:
#   bash scripts/install-git-hooks.sh            # install (set core.hooksPath)
#   bash scripts/install-git-hooks.sh status     # show current core.hooksPath
#   bash scripts/install-git-hooks.sh uninstall   # unset core.hooksPath (files remain)
#   bash scripts/install-git-hooks.sh --help
#
set -euo pipefail

HOOKS_DIR_REL="scripts/git-hooks"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! REPO_DIR="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null)"; then
  echo "ERROR: not inside a git work tree (run from a monday-bot clone)." >&2
  exit 1
fi
HOOKS_DIR_ABS="${REPO_DIR}/${HOOKS_DIR_REL}"

die() { echo "ERROR: $*" >&2; exit 1; }

cmd_install() {
  [ -d "${HOOKS_DIR_ABS}" ] || die "tracked hooks dir not found: ${HOOKS_DIR_REL}"
  [ -f "${HOOKS_DIR_ABS}/pre-commit" ] || die "pre-commit not found in ${HOOKS_DIR_REL}"
  chmod +x "${HOOKS_DIR_ABS}/pre-commit" 2>/dev/null || true
  git -C "${REPO_DIR}" config core.hooksPath "${HOOKS_DIR_REL}"
  echo "Installed: core.hooksPath -> ${HOOKS_DIR_REL}"
  echo "The pre-commit privacy hook is now live for THIS clone."
  echo "Local scope = home-path leaks only; the internal-identifier denylist is a CI backstop."
  echo "Bypass once (discouraged): git commit --no-verify"
}

cmd_status() {
  local cur
  cur="$(git -C "${REPO_DIR}" config --get core.hooksPath || true)"
  if [ -n "${cur}" ]; then
    echo "core.hooksPath = ${cur}"
  else
    echo "core.hooksPath is NOT set — hook not installed. Run: bash scripts/install-git-hooks.sh"
  fi
}

cmd_uninstall() {
  git -C "${REPO_DIR}" config --unset core.hooksPath 2>/dev/null || true
  echo "Unset core.hooksPath. The tracked hook files remain; only the wiring is removed."
}

usage() {
  cat <<EOF
install-git-hooks.sh — wire the local pre-commit privacy hook (monday-bot).

  (no args)    Install: set core.hooksPath -> ${HOOKS_DIR_REL}.
  status       Show the current core.hooksPath.
  uninstall    Unset core.hooksPath (tracked files remain).
  --help, -h   This help.

Local scope is HOME-PATH leaks only; the internal-identifier denylist is enforced by CI.
EOF
}

main() {
  case "${1:-install}" in
    install | "") cmd_install ;;
    status) cmd_status ;;
    uninstall) cmd_uninstall ;;
    --help | -h) usage ;;
    *) usage; die "unknown argument: $1" ;;
  esac
}

main "$@"
