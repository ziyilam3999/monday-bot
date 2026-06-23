# Execution-review — 1171
Decision: PASS
Build: tsc exit 0 (no diagnostics)  Tests: 22 suites / 191 tests passed
Privacy-grep: CLEAN

## Scope
- Diff touches ONLY: `src/index.ts`, `src/knowledge/startup.ts`, `tests/index.startup.test.ts`, `tests/knowledge-sources.startup.test.ts`, `tests/slack-adapter.test.ts`, plus the plan doc.
- Does NOT touch `src/llm/generate.ts` or `src/slack/formatter.ts` (the in-flight #1066 files). Correct.
- `src/slack/adapter.ts` / `src/slack/commands.ts` already carried the optional-adminService back-compat from a prior task; unchanged here, consistent with the brief.

## End-to-end wiring (verified)
- Slack dispatch `/sync-confluence` → `registerAdminCommand` → `syncConfluenceCommand(this.adminService, text)` → `adminService.syncConfluence(arg||undefined)` → `sources.syncConfluence(spaceKey)` → `ConfluenceSync.syncSpace`. Argument is forwarded; empty text normalized to `undefined` in BOTH commands.ts and startup.ts. Confirmed by the `syncArgs).toEqual(["DEMO"])` test.
- `/reindex` → `reindexCommand` → `adminService.reindex` → `sources.reindexAll()`.
- `adminService.getStatus → knowledge.getStatus()`; `/status-monday` handler unchanged (`statusCommand(this.adminService)`), so the real doc count is preserved.

## Non-throwing (both layers)
- `syncConfluence`/`reindexAll` each wrap the sync loop in try/catch and return a summary string on error (`"… failed: <message>"`). They never reject.
- Defense-in-depth: `commands.ts` handlers ALSO try/catch, and `registerAdminCommand` has its own try/catch posting `DEFAULT_FALLBACK_TEXT`. Three layers — a throw cannot reach the Bolt event loop.

## "Not configured" detection
- `confluenceSync` is assigned ONLY inside the `haveAtlassianCreds && spaces.length > 0` branch (startup.ts ~133), so it stays `undefined` for BOTH (no creds) AND (creds-but-empty CONFLUENCE_SPACES). `syncConfluence` returns the exact string `"Confluence is not configured"` in both cases.
- Both branches are exercised: the "NO creds" test and the dedicated "creds present but CONFLUENCE_SPACES empty → confluence not configured; reindex is jira-only" test (which also asserts the jira fetcher is hit and the confluence fetcher is NOT — it throws if called).

## reindexAll partial config
- Independent `if (confluenceSync)` / `if (jiraSync)` guards → confluence-only, jira-only, both, neither all produce a sensible summary; neither → `"Nothing configured to reindex"`. Tests cover both, jira-only, and neither. confluence-only is untested but symmetric to jira-only (nit, not a defect).

## Back-compat
- Adapter default: `adminService = opts.adminService ?? knowledgeService`. With NO adminService and a query-only fake, `/reindex` hits the `typeof service.reindex !== "function"` guard → "not configured". Proven by the back-compat test.

## Item 4 — recordFeedbackToSink
- stdout `[feedback] <message>` printed BEFORE the try block, so it survives any file error → the operator-grep line is preserved. No double-print: when wired, `feedbackCommand` calls `service.recordFeedback` (this sink) and skips its own `[feedback]` else-branch → exactly one line.
- File I/O (`mkdirSync` + `appendFileSync`) fully inside try/catch that swallows → never throws. The "unwritable path" test (parent is a regular file) asserts `not.toThrow()`.
- Tests pin `MONDAY_FEEDBACK_LOG` to an `os.tmpdir()` path and restore the prior env in `finally`. No macOS-only path dependency in the tests (the `~/Library/Logs` default is only the unset-env fallback, never reached in CI) → no ubuntu/windows flake.

## Nits (non-blocking)
- reindexAll aborts remaining sources if an earlier source's syncSpace/syncProject throws (e.g. confluence error skips jira), returning "Reindex failed". Acceptable under the non-throwing contract but a per-source try/catch would give a more complete summary.
- `syncConfluence(spaceKey)` will attempt to sync an arbitrary spaceKey not in `confluenceSpaces`; harmless (fetcher returns empty or the error is caught), and matches "sync the given space" intent.
- confluence-only reindex path has no dedicated test (symmetric coverage exists for jira-only).

## Verdict
PASS — logic is correct end-to-end, all required branches are tested, three layers guarantee non-throwing, privacy grep CLEAN, scope respected, build + 191 tests green.
