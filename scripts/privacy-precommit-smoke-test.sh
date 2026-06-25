#!/usr/bin/env bash
# privacy-precommit-smoke-test.sh — both-ends smoke for the local pre-commit privacy
# leg (#1222 Leg 2). The ORACLE for AC13/AC14/AC15/AC16/AC18.
#
# HERMETIC: operates ONLY on synthetic scratch git repos under a mktemp dir — never the
# real repo's history or remotes. The scratch repos deliberately have NO origin/master,
# which is exactly what proves staged mode resolves NO range (M4).
#
# PRIVACY (PUBLIC repo, load-bearing): the ONLY synthetic fixtures used are the home
# path `/Users/synthuser/x` and the denylist-shape token `synthtoken`. No real home
# path, no real internal-identifier token appears anywhere in this file.
#
# Prints per-case PASS/FAIL + "PASS=N FAIL=M"; exits 0 (the trailing test sets the code).

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="${HERE}/privacy-denylist-check.sh"
INSTALLER="${HERE}/install-git-hooks.sh"
PRECOMMIT="${HERE}/git-hooks/pre-commit"

PASS=0
FAIL=0

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t ppcsmoke)"
trap 'rm -rf "$TMP"' EXIT

assert() {  # <label> <cond-result(0=pass)> [detail]
  if [ "$2" -eq 0 ]; then PASS=$((PASS+1)); echo "PASS: $1"
  else FAIL=$((FAIL+1)); echo "FAIL: $1 ${3:-}"; fi
}

# fresh_repo <name> -> echoes path to a new git repo with NO remote / NO origin/master.
fresh_repo() {
  local d="$TMP/$1"
  git init -q "$d"
  git -C "$d" config user.email "smoke@example.test"
  git -C "$d" config user.name "smoke"
  git -C "$d" config commit.gpgsign false
  printf '%s' "$d"
}

# --- AC13: staged HOME-PATH fixture in a no-origin/master repo -> BLOCKS (non-zero) ---
R="$(fresh_repo ac13)"
printf 'base dir: /Users/synthuser/x\n' > "$R/leak.txt"
git -C "$R" add leak.txt
( cd "$R" && SCAN_MODE=staged bash "$CHECK" ) >/dev/null 2>&1; rc=$?
{ [ "$rc" -ne 0 ]; }
assert "AC13 staged home-path leak (no origin/master) -> BLOCKS (rc=$rc, want non-zero)" $?

# --- AC14: staged CLEAN fixture in the SAME no-origin/master shape -> exit 0 ---
R="$(fresh_repo ac14)"
printf 'use a relative path ./notes/x or a <name> placeholder\n' > "$R/clean.txt"
git -C "$R" add clean.txt
( cd "$R" && SCAN_MODE=staged bash "$CHECK" ) >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 0 ]; }
assert "AC14 staged clean fixture (no origin/master) -> exit 0 (rc=$rc, want 0)" $?

# --- AC15a: PRIVACY_DENYLIST_TOKENS UNSET + staged synthtoken, NO home path -> exit 0 ---
R="$(fresh_repo ac15a)"
printf 'config value: synthtoken\n' > "$R/tok.txt"
git -C "$R" add tok.txt
( cd "$R" && env -u PRIVACY_DENYLIST_TOKENS SCAN_MODE=staged bash "$CHECK" ) >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 0 ]; }
assert "AC15a token UNSET + synthtoken staged -> exit 0 (vacuous local skip) (rc=$rc, want 0)" $?

# --- AC15b: PRIVACY_DENYLIST_TOKENS=synthtoken SET (CI-shape) -> BLOCKS the same fixture ---
R="$(fresh_repo ac15b)"
printf 'config value: synthtoken\n' > "$R/tok.txt"
git -C "$R" add tok.txt
( cd "$R" && env PRIVACY_DENYLIST_TOKENS=synthtoken SCAN_MODE=staged bash "$CHECK" ) >/dev/null 2>&1; rc=$?
{ [ "$rc" -ne 0 ]; }
assert "AC15b token armed=synthtoken -> BLOCKS same fixture (rc=$rc, want non-zero)" $?

# --- AC16: DEFAULT (range) mode + bogus/unresolvable base -> exit 1 (M2 fail-closed) ---
R="$(fresh_repo ac16)"
printf 'seed\n' > "$R/seed.txt"
git -C "$R" add seed.txt
git -C "$R" commit -q -m seed
( cd "$R" && env GITHUB_BASE_REF="no-such-ref-xyz" bash "$CHECK" ) >/dev/null 2>&1; rc=$?
{ [ "$rc" -eq 1 ]; }
assert "AC16 default mode + unresolvable base -> exit 1 (fail-closed) (rc=$rc, want 1)" $?

# --- AC18: installer wires core.hooksPath to the tracked dir ---
R="$(fresh_repo ac18)"
mkdir -p "$R/scripts/git-hooks"
cp "$INSTALLER" "$R/scripts/install-git-hooks.sh"
cp "$PRECOMMIT" "$R/scripts/git-hooks/pre-commit"
cp "$CHECK" "$R/scripts/privacy-denylist-check.sh"
( cd "$R" && bash scripts/install-git-hooks.sh ) >/dev/null 2>&1
cur="$(git -C "$R" config --get core.hooksPath || true)"
{ [ "$cur" = "scripts/git-hooks" ]; }
assert "AC18 installer -> core.hooksPath = scripts/git-hooks (got '$cur')" $?

# --- AC18b: the installed hook actually fires end-to-end (commit blocked on a staged leak) ---
printf 'oops: /Users/synthuser/x\n' > "$R/leak2.txt"
git -C "$R" add leak2.txt scripts/
git -C "$R" commit -q -m "should be blocked" >/dev/null 2>&1; rc=$?
{ [ "$rc" -ne 0 ]; }
assert "AC18b installed pre-commit blocks a real staged-leak commit (rc=$rc, want non-zero)" $?

# --- AC12: pre-commit + checker pass bash -n ---
{ bash -n "$PRECOMMIT" 2>/dev/null && bash -n "$CHECK" 2>/dev/null && bash -n "$INSTALLER" 2>/dev/null; }
assert "AC12 bash -n pre-commit + checker + installer clean" $?

echo "----------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
