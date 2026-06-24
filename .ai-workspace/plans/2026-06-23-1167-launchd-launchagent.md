# Task #1167 — Run monday-bot 24/7 on macOS via a launchd LaunchAgent

## ELI5

The operator's Mac is on 24/7 and always logged in. They want Monday (the Slack
bot) to start automatically, stay running, and restart itself if it crashes —
without babysitting a terminal and without PM2. macOS's native supervisor for
this is **launchd**: you hand it a small `.plist` describing what to run, where,
and "keep it alive", and the OS does the rest.

The repo is PUBLIC, so the plist can't contain the operator's real home path,
username, node path, or hostname. So we ship a **template** full of
`<PLACEHOLDER>` tokens plus an **install script** that resolves the real values
on the operator's machine at install time and writes the filled plist into
`~/Library/LaunchAgents/`. We do NOT load the agent ourselves — `launchctl
bootstrap` is the operator's blessed activation step (one command).

## Execution model

**3-role, orchestrated.** Planner inline (this doc, per the #1167 brief).
plan-review, executor (build of template+script+docs+test), and execution-review
are real ledger roles. Code delta is shell + a plist template + a README section +
one jest test (no TS source change), but the brief mandates the full loop.
Artifacts committed (force-added, `.ai-workspace/` is gitignored) so the ledger
`--artifact` paths survive on master.

## What changes (new/modified files)

1. **`deploy/launchd/com.monday-bot.plist.template`** (new) — LaunchAgent plist with
   placeholder tokens:
   - `Label` = `com.monday-bot`
   - `ProgramArguments` = [`<NODE_PATH>`, `<REPO_DIR>/dist/index.js`]
   - `WorkingDirectory` = `<REPO_DIR>`
   - `RunAtLoad` = true, `KeepAlive` = true (restart on crash)
   - `StandardOutPath` = `<LOG_DIR>/monday-bot.out.log`,
     `StandardErrorPath` = `<LOG_DIR>/monday-bot.err.log`
   - `EnvironmentVariables` → `PATH` = `<PATH_VALUE>` (so node + tools resolve under
     launchd's minimal env). `.env` itself is still self-loaded by the bot
     (v0.12.6 `process.loadEnvFile()` from `WorkingDirectory`), so no secrets in
     the plist.
   - `ProcessType` = Background (headless service, per plan-review nit), `ThrottleInterval` = 10 (crash-loop backoff).

2. **`scripts/install-launchd.sh`** (new, shellcheck-clean, idempotent) —
   - `set -euo pipefail`; resolves: `NODE_PATH=$(command -v node)`, `REPO_DIR` =
     repo root via `git rev-parse --show-toplevel` (fallback to script's `../`),
     `LOG_DIR="$HOME/Library/Logs"`, `PATH_VALUE` = dirname(node) prepended to a
     sane default PATH.
   - FAIL LOUDLY (exit 1, named cause) if: node missing, `dist/index.js` missing
     (hint `npm run build`), `.env` missing (hint: populate it).
   - Fills the template with `sed`/parameter expansion → writes
     `~/Library/LaunchAgents/com.monday-bot.plist` (mkdir -p the dir first).
   - PRINTS the activation commands and, for the non-`--print-only` path, performs
     idempotent (re)install: `launchctl bootout` (ignore error if not loaded) →
     `bootstrap` → `enable` → `kickstart -k`. Activation is gated behind an
     explicit confirm/flag so it's operator-confirmable; default prints + asks.
   - Subcommands: `install` (default), `--print-only`, `uninstall` (bootout +
     remove plist), `status` (`launchctl print`), `--help`. Tail-logs hint shown.

3. **`README.md`** — new "Run 24/7 on macOS (launchd)" section: prerequisites
   (`npm run build`, populated `.env`), the one command
   (`bash scripts/install-launchd.sh`), status/logs, update (rebuild + kickstart),
   uninstall. CAVEAT documented: a LaunchAgent runs only while the user is logged
   in (fine for an always-on logged-in Mac); a LaunchDaemon would be needed for
   pre-login/headless. PM2 / `ecosystem.config.js` section kept intact.

4. **`tests/install-launchd.test.ts`** (new) — cross-platform jest spec:
   - template contains all required plist keys + every placeholder token, and
     contains NO real-path/username leakage (`/Users/`, literal home, hostname).
   - script: contains `set -euo pipefail`, the fail-loud guards, the launchctl
     verbs, and is `bash -n` clean (guarded to skip the `bash -n` spawn on win32).

## Non-goals

- Do NOT delete / alter `ecosystem.config.js` (PM2 = future cloud path).
- Do NOT run `launchctl bootstrap` from CI or from the agent — operator's step.
- No TS source change; no new npm dependency.
- No LaunchDaemon (documented as the headless alternative only).

## Privacy (PUBLIC repo)

No real home path, username, node path, or hostname in any tracked file. Template
uses `<PLACEHOLDER>` tokens; script resolves at runtime. Run ai-brain privacy
denylist + a `git grep` for `/Users/<user>` / `$USER` literal / hostname before
push.

## Binary AC (checkable from outside the diff)

- AC1: `npm run build` exits 0 (tsc clean) — unchanged TS.
- AC2: `npm test` exits 0 — existing suite + new install-launchd test green.
- AC3: `bash -n scripts/install-launchd.sh` exits 0; shellcheck (if available) clean.
- AC4: `grep -c "<NODE_PATH>\|<REPO_DIR>\|<LOG_DIR>\|<PATH_VALUE>"` on the template
  ≥ 4; `git grep -n "/Users/"` over tracked files = 0 matches in the new files.
- AC5: template has `KeepAlive`, `RunAtLoad`, `Label`, `ProgramArguments`,
  `WorkingDirectory`, `StandardOutPath`, `StandardErrorPath`, `EnvironmentVariables`.

## Critical files

- `deploy/launchd/com.monday-bot.plist.template` (new)
- `scripts/install-launchd.sh` (new)
- `README.md` (Deployment area)
- `tests/install-launchd.test.ts` (new)
- `ecosystem.config.js` (must stay untouched)

## Review

(plan-review verdict in .ai-workspace/reviews/2026-06-23-1167-plan-review.md)
