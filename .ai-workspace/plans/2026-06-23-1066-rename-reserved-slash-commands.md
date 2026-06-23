# 1066 — Rename two slash commands that collide with Slack reserved words

## ELI5

Slack reserves some slash-command names for its own built-ins. Two of our bot's
admin commands — `/status` and `/feedback` — clash with those reserved words, so
Slack can swallow or shadow them. The fix is a pure rename: call them
`/status-monday` and `/feedback-monday` instead. Nothing about how the commands
WORK changes — only the text of the command name. The other commands (`/ask`,
`/sync-confluence`, `/reindex`, `/help`) are NOT reserved and stay exactly as they are.

## Execution model

**subagent.** Knob A = `delegate` (one fresh executor subagent), Knob B = `reviewer`
(stateless execution-review subagent) plus the build+test oracle. Rationale: the change
is fully specified (exact edit sites + Binary AC) but spans 2 source files + docs, which
is above the trivial-skip threshold (single file AND <10 LOC), so the canonical 3-role
loop applies: planner is inline-skipped (the orchestrator brief already encodes the plan
and AC; there is no design decision to delegate), plan-review + executor + execution-review
run as real subagents.

## Scope

Mechanical string rename only. No logic change, no new behavior, no test changes
expected (the orchestrator already grepped — there are no test references to the
old command strings).

### Renames
- `/status` → `/status-monday`
- `/feedback` → `/feedback-monday`

### Leave UNCHANGED
- `/ask`, `/sync-confluence`, `/reindex`, `/help` (not Slack-reserved).
- The internal `commandHandlers` registry keys (`status`, `feedback`, …) — these are
  code identifiers, not user-facing slash tokens, and the AC tests key on them.

## Edit sites (already located by the orchestrator)

1. `src/slack/adapter.ts` — `registerAdminCommand("/status", …)` → `"/status-monday"`.
2. `src/slack/adapter.ts` — `registerAdminCommand("/feedback", …)` → `"/feedback-monday"`.
3. `src/slack/commands.ts` — `AVAILABLE_COMMANDS` `{ name: "/status", … }` → `"/status-monday"` (drives `/help`).
4. `src/slack/commands.ts` — `{ name: "/feedback <message>", … }` → `"/feedback-monday <message>"`.
5. `src/slack/commands.ts` — usage string `"Usage: /feedback <message> — …"` → `/feedback-monday`.
6. Cosmetic doc-comments referencing the old names in both files — update for consistency.
7. `README.md` / `CHANGELOG.md` / `.env.example` — update only user-facing slash-command
   tokens `/status` and `/feedback`; do NOT touch the unrelated prose word "status", and do
   NOT rewrite historical CHANGELOG entries (immutable release records).

## Privacy (public repo)

No employer brand / host / Confluence space key / Jira project key introduced. The new
command names are generic. Run a privacy grep over the diff before push.

## Binary AC

- `npm run build` exits 0 (tsc clean).
- `npm test` all suites green.
- `git grep -n '"/status"'` and `git grep -n '"/feedback"'` over `src/` return ZERO hits
  (the two registered command strings are renamed).
- `git grep -n '"/status-monday"'` and `git grep -n '"/feedback-monday"'` over `src/` each
  return at least the adapter registration + the commands.ts AVAILABLE_COMMANDS entry.
- `/ask`, `/sync-confluence`, `/reindex`, `/help` strings are unchanged in `src/`.
- Privacy grep over the diff for the regulated employer-brand / host tokens returns ZERO hits (the exact denylist patterns are kept out of this public-repo artifact; the orchestrator supplied them out-of-band).

## Review

(plan-review subagent fills this in)
