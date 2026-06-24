# Execution Review — #1166 (Confluence wiring) + #1168 (Jira ingester)

Reviewer: stateless execution-reviewer (did not author the diff)
Worktree: .claude/worktrees/1166-confluence-jira
Date: 2026-06-22

## Decision: PASS

## Build / Test (run by reviewer)
- `npm run build` → tsc clean (no errors).
- `npm test` → **21 suites passed, 169 tests passed**, 0 failed.
- Jest exited clean — **no "did not exit" / open-handle / force-exit warning** (FakeScheduler + unref'd default scheduler prevent timer leaks).

## Per-axis findings

### 1. PRIVACY — PASS
- `grep -rinE 'atlassian\.net' src tests config.yaml .env.example | grep -v 'example.atlassian.net|your-org'` → **empty** (exit 1, no leaks).
- `.env.example` uses only generic placeholders: `your-org.atlassian.net`, `you@example.com`, `SPACEA,SPACEB`, `PROJA,PROJB`. Tests use `example.atlassian.net`, `a@b.c`, `DEMO`, `PROJ`, `tok`.
- `config.yaml` jira block carries only a cron cadence (`0 */6 * * *`) + a comment explicitly stating creds/keys come from env because the repo is public. No real host/space/project/email anywhere in tracked files.
- Cairn: privacy doctrine hits confirm PUBLIC-repo scrub posture; no real tokens present. (no jira-specific cairn hits.)

### 2. JIRA CORRECTNESS — PASS
- URL: `<base>/rest/api/3/search?jql=project=<KEY>&fields=summary,description,comment&maxResults=100&startAt=<n>` at SITE ROOT (no `/wiki`). Basic auth header `Basic <base64(email:token)>`, `Accept: application/json`. Throws on non-2xx.
- Pagination TERMINATES three ways and is tested: (a) empty-page break, (b) `startAt += issues.length` advance, (c) `startAt >= total` break. Tests assert 100+100+0→stop (3 fetches), and 100+50==150→stop (2 fetches). No infinite-loop path (the empty-page guard covers a stale/zero `total`).
- `adfToText` walks the tree, tolerates null/undefined/string/`{type:text}`/container `content[]`, joins block types with `\n` and collapses whitespace; output strips structural keys (tests assert no `type`/`paragraph` leakage).
- Comments read from `fields.comment.comments[].body`. Issue → doc indexed via `KnowledgeService.indexConfluencePage` under stable `source: jira:<KEY>` (same VectorIndex path as Confluence; `removeBySource` gives replace-on-resync — tested via dedupe-by-source test).

### 3. MUST-FIX A (the /wiki double-path bug) — GENUINELY FIXED
- `toSiteRoot()` strips a trailing `/wiki` (and trailing slash) ONCE → site root. Verified by composition:
  - `buildConfluenceFetcher` appends `/wiki/rest/api/content` → `https://host/wiki/rest/...` (no `/wiki/wiki`).
  - `buildJiraFetcher` appends `/rest/api/3/search` → `https://host/rest/...`.
- Startup feeds the SAME `siteRoot` to both builders. The startup test sets `CONFLUENCE_URL=https://example.atlassian.net/wiki` and both `confluence:c1` and `jira:PROJ-1` index successfully; the buildJiraFetcher unit test asserts the URL contains `/rest/api/3/search` and `not /wiki`.
- Non-blocking NIT (not a defect): in the startup test the fetchers are injected (mocked), so `toSiteRoot`'s output isn't asserted end-to-end against a real fetcher there. The strip is correct by inspection and covered indirectly by the Jira/Confluence fetcher unit tests. A direct unit assertion on `toSiteRoot('.../wiki') === site root` would tighten coverage.

### 4. STARTUP WIRING (#1166) — PASS
- Both sources wired when creds present (`haveAtlassianCreds = URL && EMAIL && TOKEN`, plus `CONFLUENCE_SPACES` / `JIRA_PROJECTS`).
- Graceful skip when absent: logs once ("... disabled (creds not set)") and does not throw; also distinct "no SPACES/PROJECTS configured" skip messages.
- Non-blocking: `startKnowledgeSources` returns synchronously; `adapter.start()` (index.ts:136) is NOT gated on `sources.ready`. No `await sources.ready` anywhere in the production path.
- Non-fatal: every initial sync is `.catch()`-wrapped; `ready = Promise.allSettled(...)` never rejects. Test "initial sync failure does NOT crash startup" confirms adapter starts after both fetchers throw.
- Shutdown: `sources.stop()` clears all timers (idempotent `stopped` guard), wired into `shutdown()`. Test asserts `fake.cleared === 2`.

### 5. watchedFolders OFF by default — PASS
- `config.yaml` → `watchedFolders: []`. Watcher code intact (`watchFolder`/`stopWatching`/`folderWatcher` import all present in service.ts). Test "empty watchedFolders → watchFolder is never called" passes.

### 6. TEST QUALITY — PASS
- All tests use MOCKED fetchers / `fetchImpl` stubs — no network, no creds. FakeScheduler records registrations and never starts a real timer (no leak).
- Coverage: Confluence-indexes (existing suites green), Jira ADF→doc, Jira pagination (empty-page + startAt>=total + non-2xx throw), dedupe-by-source, failure-counting without aborting batch, startup wires-both / skips-clean / sync-failure-non-fatal / watchedFolders-off.
- Tests are honest (assert real indexed chunk counts, scheduler registration counts, URL/auth shape, ADF structural-key absence), not trivialities.

## Non-blocking nits (do not block merge)
1. Direct `toSiteRoot` unit assertion would harden must-fix A coverage (see axis 3).
2. `/rest/api/3/search` + offset (`startAt`/`total`) pagination is the legacy Jira Cloud search model; Atlassian has been migrating to `/search/jql` + `nextPageToken`. Matches the plan spec, but worth a forward-looking follow-up before the legacy endpoint is removed.
3. `resolveIntervalMs` ignores `config.jira.schedule` / `confluence.schedule` (documentation-only today, hard-coded 6h). Intentional per code comment; fine for this scope.

## Conclusion
No privacy leak, no infinite-loop path, no startup crash path, tests honest and green (169/169), and the /wiki double-path bug (must-fix A) is genuinely fixed. **Decision: PASS.**
