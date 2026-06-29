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

# Tracked hooks this installer validates + arms. core.hooksPath auto-discovers
# any file in the dir, but each is still validated + chmod'd so a fresh clone is
# fully armed by ONE command.
HOOK_FILES="pre-commit post-merge"

cmd_install() {
  [ -d "${HOOKS_DIR_ABS}" ] || die "tracked hooks dir not found: ${HOOKS_DIR_REL}"
  for hook in ${HOOK_FILES}; do
    [ -f "${HOOKS_DIR_ABS}/${hook}" ] || die "${hook} not found in ${HOOKS_DIR_REL}"
    chmod +x "${HOOKS_DIR_ABS}/${hook}" 2>/dev/null || true
  done
  git -C "${REPO_DIR}" config core.hooksPath "${HOOKS_DIR_REL}"
  echo "Installed: core.hooksPath -> ${HOOKS_DIR_REL}"
  echo "The pre-commit privacy hook is now live for THIS clone."
  echo "Local scope = home-path leaks only; the internal-identifier denylist is a CI backstop."
  echo "The post-merge redeploy hook is also live: after a pull that advances bot"
  echo "source it restarts the launchd bot (#1372). It NO-OPs cleanly when the bot"
  echo "is not installed (developer clones / CI / Linux)."
  echo "Bypass once (discouraged): git commit --no-verify"
}

cmd_status() {
  local cur
  cur="$(git -C "${REPO_DIR}" config --get core.hooksPath || true)"
  if [ -n "${cur}" ]; then
    echo "core.hooksPath = ${cur}"
    echo "Tracked hooks armed: pre-commit (privacy scan), post-merge (#1372 redeploy)."
  else
    echo "core.hooksPath is NOT set — hooks not installed. Run: bash scripts/install-git-hooks.sh"
    echo "Tracked hooks that would arm: pre-commit (privacy scan), post-merge (#1372 redeploy)."
  fi
}

cmd_uninstall() {
  git -C "${REPO_DIR}" config --unset core.hooksPath 2>/dev/null || true
  echo "Unset core.hooksPath. The tracked hook files remain; only the wiring is removed."
}

usage() {
  cat <<EOF
install-git-hooks.sh — wire the local tracked git hooks (monday-bot).

  (no args)    Install: set core.hooksPath -> ${HOOKS_DIR_REL}, validate + chmod the hooks.
  status       Show the current core.hooksPath + which hooks are armed.
  uninstall    Unset core.hooksPath (tracked files remain).
  --help, -h   This help.

Tracked hooks armed by install:
  pre-commit   Local STAGED privacy scan (home-path leaks; denylist is a CI backstop).
  post-merge   #1372 redeploy — after a pull that advances bot source, restart the
               launchd bot so it rebakes dist/. NO-OPs cleanly when the bot is not
               installed (developer clones / CI / Linux).
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
