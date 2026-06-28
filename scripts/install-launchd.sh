#!/usr/bin/env bash
#
# install-launchd.sh — install Monday (the Slack knowledge bot) as a macOS
# launchd LaunchAgent so it runs 24/7 while you are logged in and restarts on
# crash. Native alternative to PM2 (ecosystem.config.js stays for the cloud path).
#
# This resolves the real node path / repo dir / log dir on THIS machine, fills
# deploy/launchd/com.monday-bot.plist.template, and writes the result to
# ~/Library/LaunchAgents/com.monday-bot.plist. It then PRINTS the launchctl
# activation commands and (with your confirmation) runs them. The repo is public,
# so no real paths live in tracked files — only the placeholder template does.
#
# Usage:
#   bash scripts/install-launchd.sh              # install + prompt to activate
#   bash scripts/install-launchd.sh --activate   # install + activate, no prompt
#   bash scripts/install-launchd.sh --print-only  # write nothing, just print plist + commands
#   bash scripts/install-launchd.sh status       # launchctl print of the agent
#   bash scripts/install-launchd.sh uninstall    # stop + remove the agent
#   bash scripts/install-launchd.sh --help
#
set -euo pipefail

LABEL="com.monday-bot"
PLIST_NAME="${LABEL}.plist"

# --- locate the repo, regardless of where the script is invoked from ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if REPO_DIR="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null)"; then
    :
else
    # Fallback: scripts/ lives one level under the repo root.
    REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

TEMPLATE="${REPO_DIR}/deploy/launchd/${PLIST_NAME}.template"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST_DST="${LAUNCH_AGENTS_DIR}/${PLIST_NAME}"
LOG_DIR="${HOME}/Library/Logs"
DOMAIN="gui/$(id -u)"
SERVICE_TARGET="${DOMAIN}/${LABEL}"

die() {
    echo "ERROR: $*" >&2
    exit 1
}

note() { echo "  $*"; }

require_macos() {
    [ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS (launchd) only; on Linux use PM2 (see ecosystem.config.js / README)."
}

# --- render-safe prerequisites (#1348 M4) -------------------------------------
# The ONLY things needed to RENDER the plist: node on PATH (its bin dir seeds the
# launchd PATH) + the template file. Deliberately does NOT require a built dist/
# or a populated .env — under the Layer-3 build-on-start wrapper, dist/ is built
# at launch (not an install precondition), and `--print-only` is a pure
# rendering/inspection path that must succeed on a CLEAN copy (no .env, no dist).
resolve_render_prereqs() {
    NODE_PATH="$(command -v node || true)"
    [ -n "${NODE_PATH}" ] || die "node not found on PATH. Install Node 18+ and retry."

    [ -f "${TEMPLATE}" ] || die "plist template not found at ${TEMPLATE}."

    # launchd starts with a minimal env; give node's own bin dir priority, then a
    # conventional default PATH so the wrapper + child tools still resolve.
    local node_bin_dir
    node_bin_dir="$(dirname "${NODE_PATH}")"
    PATH_VALUE="${node_bin_dir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

# --- activation-only prerequisites --------------------------------------------
# Checked before we actually load the agent. The dist/index.js-exists guard is
# GONE (the wrapper builds dist on start). .env is still required to ACTIVATE,
# since the bot self-loads it at startup — but it is NOT required merely to render.
resolve_activation_prereqs() {
    [ -f "${REPO_DIR}/.env" ] || die ".env not found in ${REPO_DIR}. Populate it (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ...) before installing; the bot self-loads it at startup."
}

# --- render the template to stdout (no side effects) --------------------------
render_plist() {
    local content
    content="$(cat "${TEMPLATE}")"
    content="${content//<NODE_PATH>/${NODE_PATH}}"
    content="${content//<REPO_DIR>/${REPO_DIR}}"
    content="${content//<LOG_DIR>/${LOG_DIR}}"
    content="${content//<PATH_VALUE>/${PATH_VALUE}}"
    printf '%s\n' "${content}"
}

print_activation_commands() {
    echo "Activation commands (idempotent — safe to re-run):"
    note "launchctl bootout    ${SERVICE_TARGET} 2>/dev/null || true"
    note "launchctl bootstrap  ${DOMAIN} \"${PLIST_DST}\""
    note "launchctl enable     ${SERVICE_TARGET}"
    note "launchctl kickstart -k ${SERVICE_TARGET}"
    echo
    echo "Check status:  bash scripts/install-launchd.sh status"
    echo "Tail logs:     tail -f \"${LOG_DIR}/monday-bot.out.log\" \"${LOG_DIR}/monday-bot.err.log\""
    echo "Uninstall:     bash scripts/install-launchd.sh uninstall"
}

write_plist() {
    mkdir -p "${LAUNCH_AGENTS_DIR}"
    render_plist > "${PLIST_DST}"
    echo "Wrote ${PLIST_DST}"
}

activate() {
    # Idempotent: tear down any existing instance before (re)bootstrapping.
    launchctl bootout "${SERVICE_TARGET}" 2>/dev/null || true
    launchctl bootstrap "${DOMAIN}" "${PLIST_DST}"
    launchctl enable "${SERVICE_TARGET}"
    launchctl kickstart -k "${SERVICE_TARGET}"
    echo "Activated ${SERVICE_TARGET}. It will start at login and restart on crash."
    echo "Tail logs: tail -f \"${LOG_DIR}/monday-bot.out.log\" \"${LOG_DIR}/monday-bot.err.log\""
}

cmd_install() {
    local auto_activate="${1:-prompt}"
    require_macos
    resolve_render_prereqs
    resolve_activation_prereqs
    write_plist
    echo
    print_activation_commands
    echo

    if [ "${auto_activate}" = "activate" ]; then
        activate
        return
    fi

    if [ ! -t 0 ]; then
        echo "Non-interactive shell — plist written but NOT activated."
        echo "Run the commands above, or re-run with: bash scripts/install-launchd.sh --activate"
        return
    fi

    printf 'Activate the LaunchAgent now (runs the launchctl commands above)? [y/N] '
    read -r reply
    case "${reply}" in
        y | Y | yes | YES) activate ;;
        *) echo "Skipped activation. The plist is in place; run the commands above when ready." ;;
    esac
}

cmd_print_only() {
    require_macos
    # Render-safe ONLY: must succeed on a clean copy (no .env, no dist/) — AC-6.
    resolve_render_prereqs
    echo "# Rendered plist (NOT written — --print-only):"
    echo "# would be written to: ${PLIST_DST}"
    render_plist
    echo
    print_activation_commands
}

cmd_status() {
    require_macos
    launchctl print "${SERVICE_TARGET}" 2>/dev/null \
        || die "agent ${SERVICE_TARGET} not loaded. Install it with: bash scripts/install-launchd.sh"
}

cmd_uninstall() {
    require_macos
    launchctl bootout "${SERVICE_TARGET}" 2>/dev/null || echo "Agent was not loaded (nothing to stop)."
    if [ -f "${PLIST_DST}" ]; then
        rm -f "${PLIST_DST}"
        echo "Removed ${PLIST_DST}"
    else
        echo "No plist at ${PLIST_DST} (already removed)."
    fi
    echo "Uninstalled. Logs remain in ${LOG_DIR} (delete manually if desired)."
}

usage() {
    cat <<EOF
install-launchd.sh — run Monday 24/7 on macOS via a launchd LaunchAgent.

  (no args)      Install: write ~/Library/LaunchAgents/${PLIST_NAME}, then prompt to activate.
  --activate     Install and activate without prompting.
  --print-only   Print the rendered plist + activation commands; write nothing.
  status         Show 'launchctl print' for the agent.
  uninstall      Stop (bootout) and remove the agent plist.
  --help, -h     This help.

Prerequisites: a populated .env in the repo root (required to ACTIVATE; the
build-on-start wrapper compiles dist/ on launch, so a prebuilt dist/ is NOT
required). '--print-only' renders on a clean copy with no .env/dist.
EOF
}

main() {
    case "${1:-install}" in
        install | "") cmd_install prompt ;;
        --activate) cmd_install activate ;;
        --print-only) cmd_print_only ;;
        status) cmd_status ;;
        uninstall) cmd_uninstall ;;
        --help | -h) usage ;;
        *) usage; die "unknown argument: $1" ;;
    esac
}

main "$@"
