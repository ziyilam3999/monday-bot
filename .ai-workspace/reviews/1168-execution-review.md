# Execution Review — #1168 Jira search/jql migration + per-source index-count log

Tag: 3ROLE_TASK:1168 ROLE:execution-review (stateless, independent — did not author this code).

## Build + Test (independently run)
- `npm run build` → exit 0 (tsc clean).
- `npm test` → exit 0. **21 suites passed / 21 total; 168 tests passed / 168 total.** (console.log noise is pre-existing pdfjs-dist canvas-polyfill warnings, unrelated to this change.)

## Contract verification (src/jira/sync.ts)
- **New endpoint**: URL is `${base}/rest/api/3/search/jql?...` (sync.ts:143). The removed `/rest/api/3/search?` form is gone from code AND comments.
- **Cursor on later pages only**: `let token: string | undefined` starts undefined; `if (token) url += \`&nextPageToken=${encodeURIComponent(token)}\`` (sync.ts:145) → first request omits the token, subsequent requests append it. Token is URL-encoded.
- **Response shape**: parsed as `{ issues?, nextPageToken?, isLast? }` (sync.ts:157-161). No `total` field read anywhere.
- **Stop conditions + loop guards**: primary stop `if (data.isLast === true || !token) break;` (sync.ts:169); plus `if (pages >= MAX_PAGES) break;` (cap 1000) and `if (issues.length === 0) break;`. Traced all termination cases: isLast true ✓, no token ✓, never-isLast-with-token → page cap ✓, 0-issue page that still echoes a token → falls through primary check, caught by the final 0-issue guard ✓. Terminates in every case.
- **Preserved invariants**: Basic auth header (built outside the loop, unchanged), ADF→text mapping via `toJiraIssue`/`adfToText` (untouched), `jira:<KEY>` source id (untouched), non-2xx throw with the verbatim message (sync.ts:153-155) — all intact.
- **Residue check**: `grep -nE "/search\?|startAt|\.total"` returns nothing in src/jira/sync.ts (the only matches in a broader grep were `nextPageToken` lines). Stale doc comments scrubbed of startAt/total wording.

## Contract verification (src/knowledge/startup.ts)
- Both count lines emitted via the existing `log()` abstraction (`logger.info` else `console.log`, startup.ts:88-91): `confluence:${space} indexed ${res.pagesIndexed} pages` (line 118) and `jira:${project} indexed ${res.issuesIndexed} issues` (line 151).
- **Chained BEFORE `.catch`**: `sync.syncProject(...).then((res) => log(...)).catch(...)` — the count line fires ONLY on a resolved initial sync, never on a failed one. Correct (won't claim "indexed N" on failure).
- No rogue `console.log` in the changed source paths. The only `console.log` in startup.ts is the `log()` helper's fallback (the logger abstraction itself), which is legitimate. Other repo `console.log`s (index.ts, slack/commands.ts) are pre-existing and untouched.

## Tests assert the change
- tests/jira.test.ts: URL hits `/rest/api/3/search/jql` and NOT `/wiki`; first call has NO `nextPageToken`; ≥2-page token pagination asserts exactly 2 fetches, 2nd URL carries `nextPageToken=t1`, stops on `isLast:true` (no 3rd fetch), all 200 issues accumulated; ADF single-page test retained (now `{issues, isLast:true}`); non-2xx throw retained. startAt/total-specific tests removed (contract gone).
- tests/knowledge-sources.startup.test.ts: spies `console.log` (no logger passed → falls back), asserts `confluence:DEMO indexed 1 pages` and `jira:PROJ indexed 1 issues`; spy restored via `mockRestore`.

## Defects
None. Build + test green, contract fully satisfied.

Decision: PASS
