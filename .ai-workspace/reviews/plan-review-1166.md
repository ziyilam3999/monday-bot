# Plan Review — #1166 wire Confluence + #1168 add Jira knowledge sources

Stateless plan-review. Reviewer did NOT write the plan. Cross-checked against the live worktree
(`src/confluence/sync.ts`, `src/knowledge/service.ts`, `src/index.ts`, `src/config/config.ts`,
`config.yaml`, `.env.example`, `tests/confluence.test.ts`, `tests/index.startup.test.ts`,
`tests/config.test.ts`, `tests/index.loadenv.test.ts`).

Decision: PASS

PASS with required fixes — no design blocker (no privacy leak, no non-terminating pagination
*as long as fix #2 lands*, tests can pass). The fixes below are correctness gaps the executor
MUST close, not reasons to re-plan.

cairn: `node skills/cairn/bin/cairn-find.mjs "confluence"` + `"privacy"` — no design-lesson hits
for this surface; only ship-run history (US-07 Confluence sync was the original story; US-09 added
`/sync-confluence`) and the generic employer-privacy posture (LinkedIn/secrets-to-Keychain). No
cairn anti-pattern contradicts this plan.

## Axis findings

### 1. PRIVACY (critical) — PASS
- Repo is PUBLIC and `config.yaml` is committed. Plan holds the line: all space keys / project
  keys / host / email / brand read from `process.env` at runtime; `config.yaml` keeps only the
  cron schedules + `spaces: []` (already empty on disk) and adds `jira.schedule` with NO real
  values. `.env.example` documents var NAMES only (no real values).
- AC #4 greps `src config.yaml tests .env.example README.md CHANGELOG.md` for the operator's real
  tokens (orchestrator substitutes the live values before push). Good — this is the right gate and
  it is checkable from outside the diff.
- Verified no committed test reads the repo `config.yaml` for identifiers: every startup/config
  test uses a temp YAML (`makeTempConfigYaml`, `index.loadenv.test.ts` temp files). So flipping
  `config.yaml` → `watchedFolders: []` is privacy- and test-safe.
- One watch-item (not a leak): the CHANGELOG 0.12.6→0.12.7 entry the release will add must itself
  stay brand/identifier-free. Already covered by AC #4's CHANGELOG grep.

### 2. Jira design correctness — PASS w/ required fixes
- REST shape `GET <base>/rest/api/3/search?jql=project=<KEY>&fields=summary,description,comment&maxResults=100&startAt=<n>`,
  Basic `email:apiToken`, ADF→plaintext, one chunk per issue under `jira:<KEY>`, replace-by-source
  re-sync — all reasonable and a faithful mirror of `ConfluenceSync` (which routes each doc through
  `indexConfluencePage`; an `indexJiraIssue` sibling or reuse is fine — the service already keys
  dedupe on `source`).
- **REQUIRED FIX A — base-host normalization is under-specified and will double `/wiki` for
  Confluence.** The plan defines the Jira base as `CONFLUENCE_URL` minus a trailing `/wiki`, which
  implies the operator's real `CONFLUENCE_URL` *includes* `/wiki` (the current `.env.example`
  example is literally `...atlassian.net/wiki`). But the EXISTING `buildConfluenceFetcher`
  (sync.ts:68) RE-APPENDS `/wiki/rest/api/content` to whatever baseUrl it gets. So if startup hands
  the raw `CONFLUENCE_URL` (with `/wiki`) to `buildConfluenceFetcher`, Confluence requests hit
  `.../wiki/wiki/rest/...` → broken. The startup helper MUST strip the trailing `/wiki` ONCE and
  pass the site-root base to BOTH `buildConfluenceFetcher` (re-adds `/wiki`) AND `buildJiraFetcher`
  (adds `/rest/api/3`). The plan only describes the Jira side. Fix: specify a single
  `siteRoot = CONFLUENCE_URL.replace(/\/wiki\/?$/,'').replace(/\/$/,'')` used for both; document the
  expected `CONFLUENCE_URL` form in `.env.example`; add the Confluence-side base derivation to the
  startup test (mock fetch, assert the URL has exactly one `/wiki`). Tests are mocked so CI will NOT
  catch this otherwise (Rule 18 — load-bearing URL assumption).
- **REQUIRED FIX B — pagination must guard against a zero-length page.** "Paginate while
  `startAt + issues.length < total`" does not terminate if the API ever returns `issues.length === 0`
  while `total > 0` (re-fetches the same `startAt` forever). Add an explicit `if (issues.length === 0) break;`
  and advance `startAt += issues.length`. Add a test: a 2nd page returning `[]` (or fewer than
  `maxResults`) terminates the loop and indexes only what was returned.
- **NOTE (not blocking) — ADF comment path.** Jira returns comments at
  `fields.comment.comments[]`, each with an ADF `.body` (NOT `fields.comment` directly). The ADF
  walker must handle: `description` = null | plain string | ADF object, and iterate
  `fields.comment.comments`. The plan says "each comment body" — make the executor map the
  `.comments[]` array, and add a fixture asserting a comment body lands in the doc text.
- **NOTE (not blocking, Rule 18) — endpoint deprecation.** `/rest/api/3/search` (GET, `startAt`/`total`)
  is the classic endpoint; Atlassian is migrating to `/rest/api/3/search/jql` (POST, token
  pagination, no `total`). Mocked tests pass either way, so flag for the operator to confirm the
  classic endpoint still serves their cloud instance before relying on it in production.

### 3. Testability — PASS
- `startKnowledgeSources({ ..., confluenceFetcher?, jiraFetcher?, scheduler? })` with injectable
  fetchers + scheduler is the right seam: jest injects mock fetchers (no network/creds) and a fake
  scheduler (no real `setInterval` → no open handles), and `stop()` clears timers. Production timer
  is `.unref()`'d + cleared on shutdown.
- Existing startup tests set NO `CONFLUENCE_*` env → the graceful-skip path fires → no fetcher
  built, no timer, no throw → they stay green. Verified the existing tests don't await `ready` and
  only assert adapter start + `stopWatching` on shutdown; threading `knowledgeSources.stop()` into
  `shutdown()` is additive and won't break the `stopWatching` spy.
- **REQUIRED FIX C (small) — the new env-present test must inject the fake scheduler AND call
  `shutdown()/stop()`** so no interval leaks into jest's handle check. State this explicitly in the
  test scope so the executor doesn't rely on a real timer.

### 4. watchedFolders OFF by default — PASS
- `config.yaml` → `watchedFolders: []` keeps `confluence.test.ts`'s greps satisfied (the file still
  matches `/confluence/i` and `/schedule|cron|interval/i`). `config.test.ts` and all startup tests
  use temp YAML, so the repo flip touches no assertion. Confirmed by grep: no test reads the repo
  `config.yaml` for `watchedFolders`/`test-fixtures` content (`ingestion.test.ts` only needs the
  `test-fixtures` DIRECTORY to exist, which is untouched).

### 5. Env var names — PASS
- `CONFLUENCE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`, `CONFLUENCE_SPACES`, `JIRA_PROJECTS`
  match the operator's stated `.env`. Plan correctly replaces the STALE `.env.example`
  `CONFLUENCE_BASE_URL` with `CONFLUENCE_URL` (the on-disk `.env.example` still says
  `CONFLUENCE_BASE_URL` — confirmed; the rename is needed and is in scope).

### 6. Binary AC checkable from outside the diff — PASS w/ required additions
- AC #1–#7 are all outside-the-diff checkable (tsc exit, test exit + suite presence, module
  exports, privacy grep, `config.yaml` shape, `.env.example` token presence, startup-wiring test
  assertions). Good.
- **REQUIRED FIX D — promote two edge cases to binary AC** so they're not left implicit:
  (a) empty `CONFLUENCE_SPACES`/`JIRA_PROJECTS` (and missing creds) → clean skip, no throw, no timer
  — assert in the startup test;
  (b) initial sync does NOT block `adapter.start()` and a sync REJECTION does NOT crash startup —
  assert the adapter comes up even when an injected fetcher throws.
- **NOTE — spaces/projects SOURCE.** Read `CONFLUENCE_SPACES`/`JIRA_PROJECTS` from `process.env`,
  NOT from `config.confluence.spaces` (which is `[]` in `config.yaml` and would sync nothing). The
  plan says env; make sure the executor wires env, and the test proves a space from env triggers a
  sync.

## Required-fix list (executor MUST address)
1. (Fix A) Normalize `CONFLUENCE_URL` to a site-root ONCE (strip trailing `/wiki`); pass it to both
   `buildConfluenceFetcher` (re-adds `/wiki`) and `buildJiraFetcher`. Document the expected
   `CONFLUENCE_URL` form in `.env.example`. Add a mocked-fetch assertion that the Confluence URL
   contains exactly one `/wiki`.
2. (Fix B) Guard Jira pagination against a zero-length page (`break` + advance `startAt += issues.length`);
   test that an empty/short page terminates.
3. (Fix C) New startup test injects a fake scheduler and calls `stop()/shutdown()` — no leaked timer.
4. (Fix D) Add binary AC: empty `CONFLUENCE_SPACES`/`JIRA_PROJECTS` + missing creds → clean skip;
   initial sync non-blocking + sync failure non-fatal to startup.
5. (Notes) Map Jira comments via `fields.comment.comments[]`; tolerate description null/string/ADF;
   read spaces/projects from env not config; operator to confirm `/rest/api/3/search` not deprecated
   for their instance.
