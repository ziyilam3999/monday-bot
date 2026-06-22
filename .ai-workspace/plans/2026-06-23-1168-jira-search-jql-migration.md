# #1168 — Jira ingester migrate to /rest/api/3/search/jql + per-source index-count log

## ELI5
The robot used to ask Jira for tickets through an old door (`/rest/api/3/search`).
Atlassian bricked that door — now it answers "410 Gone", so the live sync breaks.
We point the robot at the new door (`/rest/api/3/search/jql`). The new door hands
back pages using a "next-page ticket" (`nextPageToken`) instead of counting from a
total, so we change how we flip through pages. We also add one tiny status line per
source at startup ("confluence:SPACE indexed N pages" / "jira:KEY indexed M issues")
so the operator can confirm BOTH sources came up by reading stdout.

## Execution model
- **subagent** (knob A = `delegate`, knob B = `test-oracle` + `reviewer`). Single coherent
  surface (2 src files + 2 test files), briefable, exact fix specified by the operator.
  Planner inline-skipped (orchestrator brief gives the exact contract); plan-review,
  executor, and execution-review run as REAL stateless subagents per the 3-role model.
  Rationale: >10 LOC across 4 files -> above trivial-skip, so it is delegated, not inlined.

## Context / cairn
- CONFIRMED-LIVE contract (operator-verified, do not second-guess):
  - OLD `GET <base>/rest/api/3/search?jql=...&startAt=N&maxResults=100` -> HTTP 410 Gone (removed).
  - NEW `GET <base>/rest/api/3/search/jql?jql=<encoded>&fields=summary,description,comment&maxResults=100`
    -> 200. Shape `{ issues: [...], nextPageToken: string|undefined, isLast: boolean }`.
    Token pagination: pass `&nextPageToken=<token>` on subsequent pages; STOP on
    `isLast === true` OR no `nextPageToken`. NO `total` field.
- cairn: no hits for "jira search jql 410" (plan-reviewer subagent to re-run `node skills/cairn/bin/cairn-find.mjs`).
- Files: src/jira/sync.ts (fetcher), src/knowledge/startup.ts (count log), tests/jira.test.ts,
  tests/knowledge-sources.startup.test.ts.

## Changes

### FIX 1 — src/jira/sync.ts `buildJiraFetcher.fetchIssues`
- URL -> `<base>/rest/api/3/search/jql?jql=<encoded project=KEY>&fields=summary,description,comment&maxResults=100`;
  append `&nextPageToken=<token>` ONLY on pages after the first.
- Replace startAt/total loop with token pagination:
  - `let token: string | undefined; const out = []; let pages = 0;`
  - loop: build url (+token if set), fetch, !res.ok -> throw (keep existing message),
    parse `{ issues?, nextPageToken?, isLast? }`, map+push issues,
    `token = resp.nextPageToken`, `pages++`.
  - break when `resp.isLast === true || !token`.
  - infinite-loop guards: cap pages at a sane max (e.g. 1000) AND break if a page
    returns 0 issues with no token.
- Keep Basic auth, ADF->text mapping (`toJiraIssue`/`adfToText`), `jira:<KEY>` source id.
- Update stale doc comments (~line 13 module doc, ~106-108 buildJiraFetcher doc) to new
  endpoint + token pagination (remove startAt/total wording).

### FIX 2 — src/knowledge/startup.ts (observability)
- After each source's initial sync resolves, log a one-liner via the existing `log()`
  helper (logger.info -> console.log fallback; same interface already used):
  - Confluence: `.then((res) => log(\`confluence:${space} indexed ${res.pagesIndexed} pages\`))`
    before the existing `.catch`.
  - Jira: `.then((res) => log(\`jira:${project} indexed ${res.issuesIndexed} issues\`))`
    before the existing `.catch`.
- Existing caught-error logs stay. No new console.log noise outside the logger abstraction.

## Tests
- tests/jira.test.ts (rewrite the `buildJiraFetcher` HTTP block):
  - (a) request URL hits `/rest/api/3/search/jql` and NOT the bare old `/search?`;
    first call has NO `nextPageToken`.
  - (b) token pagination across >=2 pages: page1 `{issues, nextPageToken:"t1", isLast:false}`,
    page2 `{issues, nextPageToken:undefined, isLast:true}`; assert 2 fetches, 2nd url
    contains `nextPageToken=t1`, stops (no 3rd fetch), all issues accumulated.
  - keep: single-page ADF map test (now returns `{issues, isLast:true}`), non-2xx throw test.
  - drop the startAt/total-specific tests (contract removed).
- tests/knowledge-sources.startup.test.ts:
  - extend the "wires both" test to spy on `console.log` and assert it received
    `confluence:DEMO indexed 1 pages` and `jira:PROJ indexed 1 issues`.

## Binary AC
- `npm run build` exits 0 (tsc clean).
- `npm test` exits 0 (full suite green).
- `grep -n "search/jql" src/jira/sync.ts` matches; `grep -nE "/search\?|startAt|\.total" src/jira/sync.ts` returns nothing.
- `grep -nE "indexed .* pages|indexed .* issues" src/knowledge/startup.ts` matches both lines.

## Out of scope
- No change to ADF mapping, auth, source-id, or scheduling.

## Deferred-follow-ups:
- Live Jira smoke against the real GET project (GET-798) + confirm both per-source
  counts from stdout — DEFERRED to the orchestrator post-merge (no .env in worktree).
  -> orchestrator owns; not a code task.
- none others.

## Review

Reviewed by stateless plan-reviewer (3ROLE_TASK:1168 ROLE:plan-review).

### Verified against source
- **Endpoint migration matches reality.** `src/jira/sync.ts:132-159` currently builds the
  REMOVED `/rest/api/3/search?...&startAt=N` URL and paginates on `startAt`/`total`. The plan's
  FIX 1 (swap to `/rest/api/3/search/jql`, token pagination on `nextPageToken`/`isLast`, drop
  `startAt`/`total`) is the correct delta. Stale doc comments DO exist at module-doc line 13 and
  `buildJiraFetcher` doc lines 106-108 — the plan calls them out explicitly. Good.
- **Token-pagination design is correct + loop-safe.** Stop on `isLast === true || !token`, plus
  two independent infinite-loop guards (page cap ~1000 AND break on a 0-issue page with no token).
  Adequate for a server that misbehaves (never sets `isLast`, keeps echoing a token).
- **Preserved invariants confirmed.** ADF mapping (`adfToText`/`toJiraIssue`), Basic auth header,
  `fields=summary,description,comment`, and the `jira:<KEY>` source id all live OUTSIDE the
  paginate loop body the plan rewrites — none are touched. `JiraFetcher.fetchIssues(projectKey)
  -> JiraIssue[]` signature is unchanged, so `JiraSync` and all stub-fetcher tests stay valid.
- **FIX 2 is feasible as written.** `JiraSyncResult.issuesIndexed` (sync.ts:48) and
  `ConfluenceSyncResult.pagesIndexed` (confluence/sync.ts:36-38, returned at :178) both exist, so
  `.then((res) => log(...))` reads real fields. The `log()` helper (startup.ts:88-91) routes through
  `logger.info` else `console.log` — no rogue `console.log`. The `.then` is chained BEFORE the
  existing `.catch`, so a count line is emitted only on a RESOLVED initial sync (correct: never
  claim "indexed N" on a failure). Scheduled re-syncs intentionally get no count line.
- **Test plan proves the change.** (a) URL hits `/search/jql`, first call has no `nextPageToken`;
  (b) ≥2-page token pagination asserts the 2nd URL carries `nextPageToken=t1`, stops on
  `isLast:true`, accumulates all issues; ADF single-page + non-2xx-throw retained; startAt/total
  tests dropped (contract removed). Startup test spies `console.log` for both count lines — note the
  "wires both" test passes NO `logger`, so `log()` falls to `console.log` and the spy fires (the
  sibling failure test already spies `console.error`, no conflict).

### Binary AC sanity
- `grep -nE "/search\?|startAt|\.total"` returns nothing AFTER the fix: the new URL is
  `/search/jql?` (does NOT contain the literal `/search?`), and `startAt`/`total` leave both code
  and the rewritten doc comment. Internally consistent.

### Notes for the executor (non-blocking)
1. Add the `console.log` spy to the "wires both" startup test only; restore it (`mockRestore`) in
   that test to avoid leaking the spy into siblings.
2. Keep the existing non-2xx throw message verbatim so the `rejects.toThrow(/401/)` test still passes.
3. When rewriting the `buildJiraFetcher` doc comment, scrub EVERY `startAt`/`total` token there — the
   grep AC reads the whole file, comments included.

cairn: no hits for "jira pagination" / "nextPageToken" / "atlassian 410" (only an unrelated #94
backlog-triage line and substring noise in session-notes) — no prior art to reconcile.

Decision: PASS
