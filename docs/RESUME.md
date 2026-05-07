# monday-bot — Cross-Machine Resume Pointer

**Last updated**: 2026-05-07
**Origin**: Windows session `monday` (decommissioning)
**Intended consumer**: macbook-monday (or any future monday-bot session, on any machine)

---

## Last shipped state

- **Latest tag**: `v0.10.0` (US-10 Graceful Errors), PR #125 merged 2026-04-30 → release PR #130 → tag `v0.10.0`.
- **Master**: clean as of 2026-05-01T04:18Z (Windows verification).
- **Stories shipped**: US-01 through US-10 (10 of 13).

## Pending TaskList (recreate via TaskCreate after fresh session)

| ID | HEADLINE | Notes |
|----|----------|-------|
| #58 | forge_generate + ship **US-11** (Config file) | NEXT. Will be the **first PASS hitting the W3 conditional-write fix** in forge-harness #521. Expect zero diff churn in `docs/decisions/INDEX.md` and `docs/generated/TECHNICAL-SPEC.md` outside US-11's own row + section. Capture as audit evidence — forge-plan asked for this dogfood signal. |
| #59 | forge_generate + ship **US-12** (E2E integration) | Blocked behind #58. |
| #60 | forge_generate + ship **US-13** (Deployment packaging) | Blocked behind #59. |
| #61 | Wrap monday-bot phase — `/project-index` + final `forge_coordinate` | Closes PH-02. |
| #72 | Per-story forge-harness audit ritual (US-06..US-13) | Meta-task. US-06..US-10 done; US-11..US-13 still owed. Playwright snapshot at every dashboard event (pre-generate / post-generate / post-evaluate / post-coordinate). Save report card to `.ai-workspace/runs/run-pr<NN>.json`. Mail forge-plan with findings. |

## Open mail threads (as of 2026-05-07)

| Thread | Status | Awaiting |
|--------|--------|----------|
| `monday-bot-windows-closeout-2026-05-05` | macbook-monday read the row 5 fix mail (forge-harness MCP registration unblock) on 2026-05-07. | macbook-monday's reply with row 7 retry result + Ready signal. Once Ready, sender (Windows) sends Channel 2 (live state) and closes Windows session. |
| `tier-b-cards-windows-only-trap-2026-05-05` | Sent to clever-bob 2026-05-05T15:30Z. SLA expired ~36+ hours ago. | clever-bob's acknowledgement + tier ownership decision (1=bulk drain, 2=setup.sh hardening, 3=long-term sync). |
| `forge-harness-v0401-release-tag-missing` | **CLOSED** — forge-plan shipped v0.40.1 in PR #524 on 2026-05-01. | (none) |

## Resume sequence (macbook-monday or any new session)

1. **Pull repos**:
   - `cd ~/coding_projects/monday-bot && git pull && cat docs/RESUME.md` (this file lives at `docs/RESUME.md` once the PR merges)
   - `cd ~/coding_projects/forge-harness && git pull && npm install && npm run build`
   - `cd ~/coding_projects/ai-brain && git pull && bash scripts/setup.sh`
2. **Verify forge-harness MCP registration** (skip if already registered):
   ```bash
   claude mcp list | grep -q "^forge:" || claude mcp add forge node \
     "$HOME/coding_projects/forge-harness/dist/index.js" \
     -s user -e FORGE_DASHBOARD_AUTO_OPEN=1
   ```
3. **Smoke-test MCP**: open fresh Claude Code session in `monday-bot`, call `mcp__forge__forge_status`. Expect dashboard JSON.
4. **Set mailbox identity**: tell yourself "Your mailbox name is macbook-monday" (or whichever name aligns with prior threads).
5. **Run `/mailbox check`** — pick up any pending replies on the two open threads above.
6. **Recreate TaskList** via TaskCreate with the 5 pending items in the table above (in ID order).
7. **Begin US-11**: `forge_generate('US-11')` against the monday-bot execution plan. Plan path: `.ai-workspace/plans/2026-04-20-monday-bot-execution-plan-v1.json`.
8. If brief includes `callerAction: "spawn-subagent-and-await"`, use the `/forge-execute` skill protocol — fresh subagent owns implementation.
9. After implementation, `forge_evaluate('US-11')`. PASS on all ACs → proceed.
10. `/ship` Stages 0-10 (commit → branch → PR → CI → review → merge → release PR → tag).
11. `forge_coordinate` after ship to update PH-02 dashboard progress.
12. **Per-story audit ritual (#72)**: Playwright snapshot at every dashboard event, write `.ai-workspace/runs/run-pr<NN>.json`, mail forge-plan if findings.

## Side issues to know

- **forge-harness master gap**: 4 unreleased fix commits past `v0.40.1` (`1e20b1a`, `7f1dc0c`, `a221c64`, `26c8dc1`). Eventual v0.40.2 candidate, not blocking US-11.
- **No `release-please.yml`** in forge-harness — release pattern is manual `chore/release-X.Y.Z` PR.
- **Force-push ban** for `/forge-execute` subagents — never `git push --force` or `--force-with-lease`. W6 fix incoming in ai-brain.
- **Windows tier-b cards do NOT cross to macbook** — content-sync is one-way (macbook → backup repo). See `tier-b/topics/migration/2026-05-05-windows-only-tier-b-cards-do-not-cross-to-macbook.md` for the 3-tier improvement plan.
- **monday-bot release PR pattern**: direct master push is blocked. After merging a feature PR, branch `chore/release-X.Y.Z` → bump `package.json` + add CHANGELOG entry → PR → merge → tag. Confirmed thrice (PRs #113, #122, #130).

## Pickup pointers

- **This file**: `docs/RESUME.md` — durable cross-machine handoff state. (Lives in `docs/` because `.ai-workspace/` is gitignored in this repo.)
- **Active plan reference**: `.ai-workspace/plans/2026-04-20-monday-bot-execution-plan-v1.json` — original 13-story execution plan.
- **Last completed-story plan**: `.ai-workspace/plans/2026-04-26-us-06-file-watcher.md` — referenced in session bookmark; may need a fresh plan for US-11.
- **Tier-b card mirror**: `~/.claude/agent-working-memory/tier-b/topics/monday-bot/2026-05-07-cross-machine-resume-pointer.md` (Windows-side; may not be visible from macbook due to the sync gap above).
- **Mailbox**: `~/claude-code-mailbox/`. Identity registry at `.ai-workspace/.mailbox-agents.json`.

## Triangulation note

This file is one of three handoff channels for this transition:

1. **`docs/RESUME.md`** (this file) — git-tracked in monday-bot, travels via PR merge.
2. **Tier-b card** — `~/.claude/agent-working-memory/tier-b/topics/monday-bot/2026-05-07-cross-machine-resume-pointer.md`. Surfaces in pocket card on the machine that has the file.
3. **Mailbox mail** — `mailbox/inbox/2026-05-07T...-monday-to-macbook-monday-resume-pointer.md` (newest).

If this file disagrees with the mail, **trust the mail** (timestamped at handoff moment). If this file is missing on macbook, the PR may not be merged yet — `git fetch origin` and check the PR branch.
