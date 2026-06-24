# Plan: #1166 wire Confluence into runtime + #1168 add Jira as a knowledge source

Session: 0737beca-260d-4f7f-8f9b-a47df66f0154 · Tasks: #1166, #1168 · Repo: monday-bot (PUBLIC) · Release: 0.12.6 → 0.12.7

cairn: no hits run from subagent shell — orchestrator-scoped brief carries the lessons inline (privacy gate on PUBLIC repo, source-ids from .env only, release must include `git tag` + `gh release create`).

## ELI5

Monday-bot answers Slack questions by searching a pile of indexed documents. Today it only reads local folders and never talks to Confluence or Jira even though a Confluence reader already exists but is never switched on. We are going to: (1) turn ON the Confluence reader at startup so it pulls the configured wiki spaces and re-checks them on a timer; (2) build a brand-new Jira reader that pulls issues (title + description + comments) from the configured project and drops them into the same search pile; (3) turn the local-folder watcher OFF by default so the bot's knowledge is Confluence + Jira. All the secret bits (web address, login, which spaces/projects) come ONLY from the hidden `.env` file because this code is public on GitHub.

## Why

The operator wants the bot's knowledge = the configured Confluence space + the configured Jira project, with local docs off. The Confluence sync module exists but nothing calls it; Jira does not exist yet.

## Execution model

**subagent (delegate)** — one coherent write surface (a new `src/jira/` module + a startup-wiring helper + edits to `index.ts`/config/.env.example + two new test files), fully briefable from this plan with no live in-session coupling. Spans 6+ files, well above the trivial-skip threshold, so a single fresh executor subagent builds it from this plan; a stateless plan-review runs before execution and a stateless execution-review runs before ship. Rationale: disjoint from any other in-flight work, no operator-loop step, deterministic AC — the canonical /delegate shape.

## Constraints (hard)

- **PUBLIC repo + committed config.yaml** → NO space key, project key, Atlassian host, email, or brand name in ANY tracked file (code, config.yaml, tests, README, CHANGELOG, .env.example). All such values read from `process.env` at runtime ONLY.
- Env var names (operator's real `.env`, do not rename): `CONFLUENCE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`, `CONFLUENCE_SPACES` (comma-list of space keys), `JIRA_PROJECTS` (comma-list of project keys).
- Tests inject env directly + use MOCKED fetchers (worktree has NO `.env`, no network).
- Keep the FULL existing suite green + `npm run build` (tsc) clean.
- Reuse `src/confluence/sync.ts` (`ConfluenceSync`, `buildConfluenceFetcher`, injectable `ConfluenceFetcher`). Mirror its shape for Jira.
- Jira + Confluence feed the SAME `VectorIndex` via `KnowledgeService` (Jira issue → indexed doc under a stable `jira:<KEY>` source; reuse `indexConfluencePage` as the generic single-doc index path or add a sibling `indexJiraIssue`).

## Scope / files

NEW:
- `src/jira/sync.ts` — `JiraFetcher` interface, `JiraIssue`/`JiraIssueDoc` types, `buildJiraFetcher({baseUrl,email,apiToken})`, `JiraSync` class (mirrors ConfluenceSync). ADF→plaintext. Pagination via startAt/total.
- `src/jira/index.ts` — re-exports.
- `src/knowledge/startup.ts` — `startKnowledgeSources({ knowledge, env, config, confluenceFetcher?, jiraFetcher?, scheduler? })` returning `{ stop(): void, ready: Promise<void> }`. Reads env, builds fetchers when creds present, runs initial sync, schedules periodic refresh; skips gracefully (log once) when creds absent. Injectable fetchers + scheduler for tests; timers cleared by `stop()`.
- `tests/jira.test.ts` — JiraSync maps an ADF issue→doc, paginates correctly (startAt/total across ≥2 pages), buildJiraFetcher HTTP wiring (Basic auth, JQL url, base-host = CONFLUENCE_URL minus trailing `/wiki`).
- `tests/knowledge-sources.startup.test.ts` — startup wires both when env present (injected mock fetchers → assert sync ran/indexed), skips cleanly when creds absent (no throw, no timer), watchedFolders defaults off.

EDIT:
- `src/index.ts` — after building `knowledge`, call `startKnowledgeSources(...)`; thread its `stop()` into `shutdown()`. Add override fields to `RunMondayOptions` so fetchers/scheduler stay test-injectable. Initial sync runs but MUST NOT block Slack `adapter.start()` from completing and MUST NOT crash startup on sync failure.
- `config.yaml` — `watchedFolders: []` (was `- ./test-fixtures`); keep `confluence.schedule` cron. Add a `jira.schedule` cron mirroring the confluence default. NO real space/project values.
- `.env.example` — document `CONFLUENCE_URL` (replace stale `CONFLUENCE_BASE_URL`), `CONFLUENCE_SPACES`, `JIRA_PROJECTS` (names + 1-line comment each, NO real values).
- `src/config/config.ts` — add optional `jira?: { schedule?: string }` to `AppConfig` type (forward-compat; config is pass-through already).

## Design decisions

- **Jira base host** = `CONFLUENCE_URL` with any trailing `/wiki` stripped (`.replace(/\/wiki\/?$/, '')`), then trailing slash trimmed. Confluence lives under `/wiki`, Jira at site root.
- **Jira REST**: `GET <base>/rest/api/3/search?jql=project=<KEY>&fields=summary,description,comment&maxResults=100&startAt=<n>`. Paginate while `startAt + issues.length < total`. Basic auth `email:apiToken` (same as Confluence).
- **ADF → plaintext**: recursive walk of the Atlassian Document Format node tree collecting `text` nodes (join paragraphs/list items with newlines). Description + each comment body are ADF. Tolerate a missing/plain-string description.
- **Issue → doc**: `{ id: <issueKey>, title: <summary>, body: <key + summary + description + comment bodies joined>, source: "jira:<issueKey>", section: <projectKey> }`. One chunk per issue; re-sync replaces by source (same dedupe path Confluence uses).
- **Scheduling**: reuse `config.confluence.schedule` / `config.jira.schedule` if present; else default constant `DEFAULT_SYNC_INTERVAL_MS` (6h). Keep it simple — a fixed interval ms (map the documented 6h cron to 6h; any present cron → default interval is acceptable, no cron-parser dep). Timer `.unref()`'d AND cleared on `stop()` so jest has no open handles.
- **Graceful skip**: missing any of CONFLUENCE_URL/EMAIL/API_TOKEN → log once "Confluence sync disabled (creds not set)", no crash. Empty `CONFLUENCE_SPACES`/`JIRA_PROJECTS` → nothing to sync, skip. Sync errors caught + logged, never crash startup.

## Binary AC (checkable from outside the diff)

1. `npm run build` exits 0 (tsc clean).
2. `npm test` exits 0; new suites `tests/jira.test.ts` + `tests/knowledge-sources.startup.test.ts` present and passing; total test count > current.
3. Built Jira module exposes `JiraSync`, `buildJiraFetcher`, `JiraFetcher` (type) — module builds and exports.
4. `grep -riE '<real-space-key>|<real-project-key>|<atlassian-host>|<employer-brand>' src config.yaml tests .env.example README.md CHANGELOG.md` returns NOTHING (privacy gate — orchestrator runs the real grep with operator's actual tokens before push). No hardcoded identifiers.
5. `config.yaml` has `watchedFolders: []` (or empty) — local watching off by default.
6. `.env.example` contains `CONFLUENCE_SPACES` and `JIRA_PROJECTS` (documented, no real values).
7. Startup test proves: both sources wired when env+mock-fetchers present; clean skip (no throw) when creds absent; no watchFolder calls when watchedFolders empty.

## RESTORE (Rule 14 / reversible-op)

After merge: `mv ~/coding_projects/monday-bot/.claude/worktrees/1166-confluence-jira ~/coding_projects/_quarantine/1166-confluence-jira-20260622/ && git -C ~/coding_projects/monday-bot worktree prune`. Trigger: PR merged + release cut. Why: isolated worktree for this PR.

## Review

Stateless plan-review (cross-checked vs the live worktree). Privacy holds everywhere (env-only ids,
config.yaml stays brand-free, no test reads repo config.yaml); Jira design + testability + watchedFolders
flip are sound. PASS with 4 required fixes the executor must close: (A) normalize CONFLUENCE_URL to a
site-root ONCE and feed both buildConfluenceFetcher (which re-adds /wiki — else double-/wiki) and
buildJiraFetcher; (B) guard Jira pagination against a zero-length page so it terminates; (C) new startup
test injects a fake scheduler + stop() (no leaked jest timer); (D) add binary AC for clean-skip on
empty/missing creds + non-blocking, non-fatal initial sync. Notes: map comments via fields.comment.comments[],
read spaces/projects from env not config. Full review: .ai-workspace/reviews/plan-review-1166.md

Decision: PASS
