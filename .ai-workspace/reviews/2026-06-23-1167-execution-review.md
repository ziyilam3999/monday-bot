# Execution Review — Task #1167 (macOS launchd LaunchAgent)

Stateless review of the on-disk implementation in `/tmp/mb-1167` against the
contract `.ai-workspace/plans/2026-06-23-1167-launchd-launchagent.md`.

## Verdict summary: PASS

All six review dimensions and the plan's Binary AC (AC1–AC5) verified mechanically.
No blocking issues. One cosmetic nit noted.

## Evidence (commands run)

- `shellcheck scripts/install-launchd.sh` → exit 0 (clean).
- `bash -n scripts/install-launchd.sh` → exit 0.
- `npx jest tests/install-launchd.test.ts` → 8/8 pass (incl. win32-guarded `bash -n`).
- `npm run build` (tsc) → exit 0; `dist/index.js` produced.
- `git diff --quiet -- ecosystem.config.js` → UNCHANGED (not in changeset).
- Rendered plist (throwaway empty `.env`, removed after) → `plutil -lint` → **OK**.
- `git status --short` after render → 0 `.env` entries (throwaway cleaned up).

## Dimension-by-dimension

1. **Plist validity / keys** — PASS. Rendered output lints clean (`plutil -lint OK`).
   `Label`=com.monday-bot; `RunAtLoad`/`KeepAlive` both `<true/>`;
   `ProgramArguments`=[`/opt/homebrew/bin/node`, `<REPO_DIR>/dist/index.js`] (absolute
   node + entrypoint); `WorkingDirectory`=`<REPO_DIR>` (so `process.loadEnvFile()` finds
   `.env`); `EnvironmentVariables`→`PATH` present (plus `NODE_ENV=production`);
   `ProcessType`=`Background`; bonus `ThrottleInterval`=10. The template itself is
   intentionally not standalone-XML (`<NODE_PATH>` reads as a bare tag) — correct by
   design; only the rendered result is parsed and it is valid.

2. **Privacy (PUBLIC repo)** — PASS. `git grep "/Users/"` and grep for the local
   username / `/home/` over the new tracked files (template, script, test, README) = 0 matches.
   Hostname is generic `Mac`; the two README "Mac" hits are the English word in prose,
   not a host identifier. Real `/Users/...`, real node path, and repo path appear ONLY
   in the runtime-rendered plist written to the untracked `~/Library/LaunchAgents/` —
   allowed per contract. Tracked template carries only `<PLACEHOLDER>` tokens.

3. **install-launchd.sh** — PASS. `set -euo pipefail`; fails loudly (named-cause `die`,
   exit 1) on missing node / `dist/index.js` / `.env`. Idempotent: `activate()` runs
   `launchctl bootout … || true` BEFORE `bootstrap`. Subcommands install (default) /
   `--activate` / `--print-only` / status / uninstall / `--help`/`-h` all routed in
   `main`. `--print-only` → render to stdout only, never calls `write_plist` (writes
   nothing). Token replacement uses bash `${content//<TOKEN>/${VAL}}` (no sed `/`
   delimiter hazard; `<`/`>` are not glob metachars; no token is a substring of
   another). `REPO_DIR` via `git rev-parse --show-toplevel` with `${SCRIPT_DIR}/..`
   fallback. Domain `gui/$(id -u)`, service target `gui/<uid>/com.monday-bot`.

4. **Activation operator-gated** — PASS. The agent/CI never runs `bootstrap` unbidden.
   Default path prompts `[y/N]` only when interactive; in a non-interactive shell
   (`[ ! -t 0 ]`) it prints "NOT activated" and returns WITHOUT calling `activate()`.
   Activation requires an interactive `y` or explicit `--activate`. The jest test never
   invokes `launchctl`.

5. **Cross-platform test** — PASS. All assertions are fs-content reads; the sole
   subprocess (`bash -n`) is guarded via `process.platform === "win32" ? it.skip : it`.

6. **ecosystem.config.js untouched** — PASS. `git diff --quiet` clean; not in changeset.

## Binary AC

- AC1 — `npm run build` exit 0 ✓
- AC2 — new test 8/8 pass; TS source unchanged ✓
- AC3 — `bash -n` exit 0; `shellcheck` exit 0 ✓
- AC4 — template token count = 8 (≥4); `git grep "/Users/"` on new files = 0 ✓
- AC5 — template has Label, ProgramArguments, WorkingDirectory, RunAtLoad, KeepAlive,
  StandardOutPath, StandardErrorPath, EnvironmentVariables ✓

## Non-blocking nit

- Rendered `PATH` duplicates `/opt/homebrew/bin` (node's bin dir is prepended to a
  default list that already contains it). Cosmetic; irrelevant to resolution.

## Blocking issues

None.

Decision: PASS
