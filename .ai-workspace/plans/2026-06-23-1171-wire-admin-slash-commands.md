# 1171 — Wire /sync-confluence + /reindex admin slash commands

## ELI5
The bot has two "buttons" in Slack: `/sync-confluence` (go re-read the wiki now) and
`/reindex` (re-read everything now). Right now those buttons reply "not configured" —
because the thing that answers admin buttons (the knowledge service) knows how to report
status but was never taught how to *re-sync*. The auto-sync at boot already works; only the
on-demand buttons are unwired. We give the boot-time sync wiring two new public methods
(`syncConfluence`, `reindexAll`), build a small `adminService` in `index.ts` that forwards
the buttons to those methods, and hand it to the Slack adapter. Status keeps working unchanged.

## Execution model
**subagent (delegate).** Single coherent write surface (3 src files + 3 test files, all disjoint
from the in-flight #1066 PR which touches generate.ts/formatter.ts). Briefable from this plan +
the verified root cause; no live-session coupling. Knob A = `delegate`, Knob B = `both`
(real `npm test` oracle + a stateless execution-reviewer). Plan-review + execution-review are
separate stateless subagents per the 3-role model.

## Root cause (verified)
`SlackAdapter` defaults its `adminService` to the `knowledgeService` (adapter.ts:97).
`KnowledgeService` has `getStatus()` (so `/status-monday` works) but NO
`syncConfluence()`/`reindex()` → `syncConfluenceCommand`/`reindexCommand` (commands.ts:80-108)
hit their "not configured" guard. The constructed `ConfluenceSync`/`JiraSync` instances in
`startKnowledgeSources` (startup.ts) are local-scoped and discarded after wiring the scheduler,
so nothing exposes an on-demand re-sync.

## Scope (must-do = items 1-3; item 4 = secondary, do if clean)
1. **src/knowledge/startup.ts** — retain the `ConfluenceSync` + `JiraSync` instances and their
   spaces/projects lists; expose two new methods on `KnowledgeSourcesHandle`:
   - `syncConfluence(spaceKey?): Promise<string>` — re-sync one space (if given) or all configured
     spaces; return a human summary; return "Confluence is not configured" when unconfigured.
   - `reindexAll(): Promise<string>` — re-run every Confluence space + every Jira project; return a
     summary. (No on-demand folder-rescan method exists on KnowledgeService — folder watchers keep
     folders live continuously — so folders are intentionally out of reindexAll; noted, not silently dropped.)
   Both non-throwing (catch → return an error summary), consistent with the existing non-blocking design.
2. **src/index.ts** — build an `adminService`: `getStatus` delegates to `knowledge.getStatus()`
   (unchanged `/status-monday`), `syncConfluence`/`reindex` delegate to the new handle methods.
   Pass it to `new SlackAdapter({... adminService})`.
3. **src/slack/adapter.ts** — already accepts optional `adminService` (line 36/97) and defaults to
   knowledgeService for back-compat. Confirm it is used for admin commands. No name/handler changes.
   (Likely zero-diff here beyond confirmation — adapter already supports the option.)
4. **SECONDARY** — `adminService.recordFeedback(msg)` appends feedback to a durable file
   (default `~/Library/Logs/monday-bot-feedback.log`, override via `MONDAY_FEEDBACK_LOG`; dir created
   best-effort). Keep the existing stdout `[feedback] ` line. Skip + note if it balloons scope.

## Privacy (public repo)
No employer brand/host/space-key/project-key anywhere — read targets from env only (existing pattern).
Privacy git-grep the diff before push.

## Critical files
- src/knowledge/startup.ts (primary change)
- src/index.ts (adminService construction)
- src/slack/adapter.ts (confirm; likely no change)
- tests/knowledge-sources.startup.test.ts, tests/slack-adapter.test.ts, tests/commands.test.ts (tests)

## Tests
- Handle methods: mock fetchers → `syncConfluence`/`reindexAll` return the right summaries; the
  "not configured" path (no creds / no spaces).
- Adapter: `/sync-confluence` + `/reindex` invoke the adminService (NOT the "not configured" guard).
- `npm run build` (tsc clean) + `npm test` all green.

### Binary AC
- `cd <worktree> && npm run build` exits 0 (tsc clean).
- `cd <worktree> && npm test` exits 0 (all suites green, including new tests).
- The new adapter test asserts a `/sync-confluence` dispatch with a configured adminService returns a
  response that does NOT contain "not configured" and DOES contain the summary token.
- A test calls `startKnowledgeSources({...mock fetchers}).syncConfluence()` and asserts the returned string
  matches `/Re-synced confluence/`; and `.reindexAll()` matches `/Reindexed:/`; and the no-creds handle
  returns `/not configured/i` from `syncConfluence`.

## Review
### Plan-review (stateless)
Decision: PASS-WITH-NITS
cairn: WM hit `2026-04-27-pr-114-monday-bot-us09-admin-commands.md:15` — "KnowledgeService.getStatus() already existed from prior work — no service-layer changes were needed; the adapter accepts an optional `adminService` opt that defaults to `knowledgeService` for the status path." (confirms the root cause + back-compat seam this plan extends).
- BACK-COMPAT VERIFIED: adapter.ts:97 defaults adminService → knowledgeService; index.ts:125 currently omits adminService so /sync-confluence + /reindex hit the "not configured" guard (root cause is accurate). Plan's `adminService.getStatus → knowledge.getStatus()` preserves /status-monday with the real doc count (ServiceStatus already conforms to AdminServiceStatus — the existing default proves the shape matches; return it verbatim, don't reshape). index.ts bridges the `reindex`→`reindexAll` name gap correctly. Disjoint from #1066 (generate.ts/formatter.ts) — confirmed, zero file overlap.
- NON-THROWING is sound + already defense-in-depth: commands.ts:84-90/101-107 try/catch AND adapter.ts:227-239 try/catch already wrap the call, so the handle's own catch→summary is a third layer (good, keep it consistent with the non-blocking startup design at startup.ts:119-122).
- NOT-CONFIGURED branch (a) no-creds is covered by AC `/not configured/i`, but branch (b) creds-present-but-`spaces.length===0` (startup.ts:107) is a DISTINCT code path with NO AC. ADD a test: Atlassian creds set + CONFLUENCE_SPACES empty → `syncConfluence()` returns `/not configured/i`. Retain confluence-configured and jira-configured as SEPARATE flags so a jira-only deployment still reindexes jira while syncConfluence reports not-configured.
- MISSING EDGE CASES to specify in scope (not just code): (1) `reindexAll` with jira-configured-but-confluence-not (and vice-versa) — must reindex the configured source and NOT emit "not configured"; pin the mixed/partial-config summary shape so `/Reindexed:/` still matches. (2) `syncConfluence("<arbitrary key not in CONFLUENCE_SPACES>")` — decide validate-against-list vs pass-through-to-a-live-fetch (an admin can trigger a fetch for any key); state the chosen behavior, since syncSpace will hit the real API for whatever string it gets.
- ITEM 4 (secondary) cross-platform NIT: default `~/Library/Logs/monday-bot-feedback.log` is macOS-only; CI is ubuntu+windows. `mkdir(recursive)` won't fail there but pollutes `$HOME/Library/Logs`. Tests MUST pin `MONDAY_FEEDBACK_LOG` to an os.tmpdir() path (never assert the default path), and recordFeedback MUST swallow append errors (no throw) so a read-only FS can't flake CI. Plan's "skip if it balloons scope" guard is the right call — keep it strictly optional.
- AC QUALITY: build/test exit-codes + the regex-on-summary assertions are checkable from outside the diff (test-run observable, per repo convention). The exact tokens `Re-synced confluence`/`Reindexed:` are slightly how-prescriptive but acceptable as the binary contract. Privacy OK: summaries echo space/project keys only as ephemeral Slack replies at runtime; committed tests use DEMO/PROJ fakes — nothing real is baked.
