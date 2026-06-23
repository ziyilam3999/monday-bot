# 1066 Plan Review — Rename reserved slash commands

Plan reviewed: `.ai-workspace/plans/2026-06-23-1066-rename-reserved-slash-commands.md`
Reviewer: stateless plan-reviewer (independent). Change class: pure user-facing string rename
(`/status` → `/status-monday`, `/feedback` → `/feedback-monday`), no logic change.

## Review

### Strengths

- **Edit sites are real and exact.** I read both target files and confirmed every cited site:
  - `src/slack/adapter.ts:196` — `registerAdminCommand("/status", …)` ✓
  - `src/slack/adapter.ts:202` — `registerAdminCommand("/feedback", …)` ✓
  - `src/slack/commands.ts:40` — `AVAILABLE_COMMANDS` `{ name: "/status", … }` ✓
  - `src/slack/commands.ts:44` — `{ name: "/feedback <message>", … }` ✓
  - `src/slack/commands.ts:127` — usage string `"Usage: /feedback <message> — …"` ✓
  - Doc-comments in both files (adapter.ts:32-33, 95; commands.ts:5-6, 60, 120) ✓
  The list is complete for `src/` — a repo-wide grep surfaced no other `src/` occurrences.

- **Registry keys correctly left UNCHANGED.** The plan explicitly preserves the
  `commandHandlers` registry keys (`status`, `feedback`, … at `commands.ts:155-161`) and the
  named exports (`statusCommand`, `feedbackCommand`). These are code identifiers, the AC tests
  key on the substrings, and they are NOT user-facing slash tokens. Confirmed against source —
  this is the right call; renaming them would be an out-of-scope behavior change and would break
  the adapter imports + tests.

- **Binary AC is sound and checkable from OUTSIDE the diff.** `npm run build` exit 0, `npm test`
  green, and the `git grep` counts are all observable without reading implementation logic. The
  zero-hit greps are well-constructed: the pattern `'"/status"'` carries the CLOSING quote, so
  after the rename to `"/status-monday"` the literal substring `"/status"` no longer appears
  (the next char is `-`, not `"`) → the zero-hit assertion is genuinely satisfiable and will not
  false-match the new name. The presence greps for `"/status-monday"` / `"/feedback-monday"`
  pin the rename actually landed. The "untouched" assertions for `/ask`, `/sync-confluence`,
  `/reindex`, `/help` lock the scope.

- **Scope is right.** Leaving `/ask`, `/sync-confluence`, `/reindex`, `/help` unchanged is
  correct — none collide with Slack reserved words, and the plan says so explicitly.

### Gaps / risks (all non-blocking)

1. **No Slack app manifest in the repo** (verified: `find` for `*manifest*` / `slack*.yml`
   returned nothing). Good news — it means the rename is fully self-contained to code; there is
   no external slash-command declaration that would silently drift out of sync. Worth stating so
   the executor does not go hunting for one.

2. **Historical doc `docs/PLAN_MONDAY_BOT.v1.1-how-heavy.bak.md`** references the old names
   (lines 80-81, 130-134, 207, 789-814). This is a `.bak` snapshot of an old planning doc — the
   same immutable-historical class as the CHANGELOG entry the plan already (correctly) refuses to
   rewrite. The plan's edit-site 7 names only README / CHANGELOG / .env.example; recommend the
   executor treat this `.bak` the same way (leave it). Non-blocking and consistent with the
   plan's stated spirit.

3. **README.md / .env.example carry NO `/status` or `/feedback` references** (repo-wide grep).
   So edit-site 7's README/.env portions are moot — only the historical CHANGELOG matches, which
   the plan correctly excludes. The "if present" phrasing is harmless; nothing actionable there.

### Verdict rationale

The plan is coherent, the edit sites are real and complete for the runtime surface, the registry
keys the AC depends on are correctly preserved, and the Binary AC is observable from outside the
diff and free of the false-match trap. The only findings are cosmetic/historical and non-blocking.
Sound enough to execute as-is.

Decision: PASS

cairn: matched "monday-bot #53: PR created (fix/housekeep-53) — regex rename, 3 files" — confirms mechanical regex renames in this repo are routine/low-risk; no contrary lesson found for "slack command" or "rename".
