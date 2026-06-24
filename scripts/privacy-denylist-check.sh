#!/usr/bin/env bash
#
# privacy-denylist-check.sh — scan a PR's ADDED diff lines for privacy leaks.
#
# This repo is PUBLIC. The regulated employer denylist tokens live ONLY in the
# GitHub Actions secret PRIVACY_DENYLIST_TOKENS (newline-separated regex
# fragments), injected into this script via the environment. They are NEVER
# written into this file, the workflow YAML, a comment, a test, or any other
# committed file — committing them would itself be the leak this gate exists to
# prevent.
#
# Two scans run over the lines a PR ADDS (diff scope = merge-base...HEAD):
#   1. Employer-token scan — armed only when the PRIVACY_DENYLIST_TOKENS secret
#      is set; warns + skips (does NOT fail) when unset, so a PR can pass its own
#      CI before the secret is configured.
#   2. Home-path guard — always on, no secret needed; catches absolute home-dir
#      leaks like /Users/<name>/ or /home/<name>/ that a fixed token list misses.
#
# Fail-closed: an unresolvable diff range is treated as a FAILURE (exit 1), never
# a vacuous "no hits / pass". Matched content is WITHHELD from output — printing
# the matched line would re-leak the very token/username into public CI logs;
# only a count + remediation hint is printed. Set PRIVACY_VERBOSE=1 LOCALLY to
# echo matched lines for debugging (never in CI).
#
# Runs on a `pull_request` event (needs a PR base to diff against). ubuntu-only.

set -u

# --- Resolve the diff range, fail-closed (the single most important property) ---
BASE_REF="${GITHUB_BASE_REF:-master}"

# Prefer the remote-tracking ref if it resolves; else the bare ref.
RANGE_BASE=""
if git rev-parse --verify --quiet "origin/${BASE_REF}" >/dev/null; then
  RANGE_BASE="origin/${BASE_REF}"
elif git rev-parse --verify --quiet "${BASE_REF}" >/dev/null; then
  RANGE_BASE="${BASE_REF}"
else
  echo "privacy-denylist: ERROR — base ref '${BASE_REF}' does not resolve (tried 'origin/${BASE_REF}' and '${BASE_REF}')." >&2
  echo "privacy-denylist: refusing to run on an unresolvable base (a vacuous pass would hide leaks). Ensure fetch-depth: 0." >&2
  exit 1
fi

MERGE_BASE="$(git merge-base "${RANGE_BASE}" HEAD 2>/dev/null || true)"
if [ -z "${MERGE_BASE}" ]; then
  echo "privacy-denylist: ERROR — git merge-base '${RANGE_BASE}' HEAD failed or returned empty." >&2
  echo "privacy-denylist: refusing to run on an unresolvable diff range (a vacuous pass would hide leaks)." >&2
  exit 1
fi

# --- Compute ADDED lines (lines starting with '+', excluding '+++ ' headers) ---
ADDED="$(git diff --no-color "${MERGE_BASE}...HEAD" | grep -E '^\+' | grep -vE '^\+\+\+ ' || true)"

ADDED_COUNT=0
if [ -n "${ADDED}" ]; then
  ADDED_COUNT="$(printf '%s\n' "${ADDED}" | grep -c '' || true)"
fi
echo "privacy-denylist: scanning ${ADDED_COUNT} added line(s) in range ${MERGE_BASE}...HEAD"

FAIL=0

# --- Employer-token scan (armed only when the secret is set) ---
if [ -n "${PRIVACY_DENYLIST_TOKENS:-}" ]; then
  # Join non-blank lines with '|' into a single alternation.
  PATTERN="$(printf '%s\n' "${PRIVACY_DENYLIST_TOKENS}" | grep -vE '^[[:space:]]*$' | paste -sd '|' - || true)"
  if [ -n "${PATTERN}" ]; then
    TOKEN_HITS="$(printf '%s\n' "${ADDED}" | grep -iE "${PATTERN}" || true)"
    if [ -n "${TOKEN_HITS}" ]; then
      TOKEN_HIT_COUNT="$(printf '%s\n' "${TOKEN_HITS}" | grep -c '' || true)"
      echo "privacy-denylist: FAIL — a regulated employer token was found on ${TOKEN_HIT_COUNT} added line(s)." >&2
      echo "privacy-denylist: matched content WITHHELD (printing it would re-leak the token into public CI logs)." >&2
      echo "privacy-denylist: remediation — remove the regulated token from your added lines; it must not appear in this public repo." >&2
      if [ "${PRIVACY_VERBOSE:-}" = "1" ]; then
        echo "privacy-denylist: [PRIVACY_VERBOSE] matched lines:" >&2
        printf '%s\n' "${TOKEN_HITS}" >&2
      fi
      FAIL=1
    fi
  fi
else
  echo "::warning::PRIVACY_DENYLIST_TOKENS secret not set — employer-token scan skipped; set the repo secret to arm it."
fi

# --- Home-path guard (always on, no secret) ---
HOME_PATH='(/Users/|/home/)[A-Za-z0-9._-]+/'
HOME_HITS="$(printf '%s\n' "${ADDED}" | grep -E "${HOME_PATH}" || true)"
if [ -n "${HOME_HITS}" ]; then
  HOME_HIT_COUNT="$(printf '%s\n' "${HOME_HITS}" | grep -c '' || true)"
  echo "privacy-denylist: FAIL — an absolute home path was found on ${HOME_HIT_COUNT} added line(s)." >&2
  echo "privacy-denylist: matched content WITHHELD (the line contains a username)." >&2
  echo "privacy-denylist: remediation — replace the absolute home path with a relative path or an env var / placeholder." >&2
  if [ "${PRIVACY_VERBOSE:-}" = "1" ]; then
    echo "privacy-denylist: [PRIVACY_VERBOSE] matched lines:" >&2
    printf '%s\n' "${HOME_HITS}" >&2
  fi
  FAIL=1
fi

if [ "${FAIL}" -ne 0 ]; then
  exit 1
fi

echo "privacy-denylist: clean (${ADDED_COUNT} added lines scanned)."
exit 0
