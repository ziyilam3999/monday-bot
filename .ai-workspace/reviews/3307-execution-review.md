# 3307 — execution review

Task: #3307 (size M) · PR ziyilam3999/monday-bot#272 (draft) · branch 3307-issue-meta · reviewed head a72861d · base origin/master c865a53
Plan: .ai-workspace/plans/2026-10-19-3307-issue-meta.md (plan-review r2 PASS) · Executor close: .ai-workspace/reviews/3307-executor-close.md
Reviewer: execution-review seat (did not author the plan or the code)

## Review

Decision: PASS

Every Binary AC was re-run independently by this seat (not taken from the executor close). The facts line is built by code from the live fields and labelled live. The knowledge-sync, open-defects and NL-to-JQL field lists are unchanged. A mutant red control proves the privacy and fields-lock arms bite.

### AC verification (run by this seat)

| AC | Check | Result |
|---|---|---|
| AC-1 | `npx jest` (full) / `npm run typecheck` at head | rc=0, `Test Suites: 66 passed, 66 total`, `Tests: 688 passed, 688 total`; typecheck rc=0 |
| AC-2 | `-t "live meta"` | head: 1 passed · base: FAIL |
| AC-3 | `-t "live preferred"` | head: 1 passed · base: FAIL |
| AC-4 | `-t "plain unknown"` | head: 1 passed · base: FAIL |
| AC-5 | `-t "meta failure honest"` (reject + never-resolves past the 5 s box) | head: 2 passed · base: both FAIL |
| AC-6 | `-t "parity"` | head: pass · base: pass (must-not-fire, as expected) |
| AC-7 | `-t "no fetcher"` | head: pass · base: pass (deep-equals the generator's own return) |
| AC-8 | `-t "privacy"` (REAL one-issue fetcher, fake fetchImpl, assignee has displayName + emailAddress) | head: pass · base: FAIL |
| AC-9 | `-t "fields lock"` + `npx jest tests/jira.test.ts` | head: 2 passed; jira.test 13/13 · base: widened-list arm FAIL, sync-no-meta arm pass |
| AC-10 | new suite at pristine `git archive origin/master` copy + new suite/fixture | base: `Tests: 7 failed, 3 passed, 10 total` (suite compiles and runs; every must-fire arm fails on an assertion, not an import) · head: 10/10 green |

Red control (mutant, scratch copy of head, never the worktree): mapper changed to read `emailAddress` instead of `displayName`, and the sync fetcher's fields gained `status`. Result: `Tests: 2 failed, 8 passed` — the privacy arm and the fields-lock arm both go RED. AC-9 really observes each fetcher's request URL through a fake fetch; it is not a source-text grep.

Privacy (brief item 9): added lines matching the real-project-key pattern = `0` (positive control on a seeded scratch line carrying the pattern = `1`). Canonical scanner: `bash scripts/privacy-scan.sh --working src/jira/sync.ts src/knowledge/service.ts tests/key-lookup-meta.test.ts tests/key-lookup.test.ts tests/fixtures/key-lookup/meta-issues.json .ai-workspace/plans/2026-10-19-3307-issue-meta.md .ai-workspace/reviews/3307-executor-close.md .ai-workspace/reviews/3307-plan-review.md` → `privacy-scan: CLEAN mode=working size=128036`; positive control (scratch file with a runtime-built home path) → `DIRTY (home-path matches=1, ...)`. The only email-shaped string in added lines is the fixture's synthetic `@demo.example` address, which is the AC-8 input. That is correct.

PR CI at review time: build pass, denylist pass.

### Checks the brief asked to look at hardest

1. Stale indexed text shown as current: see the disposition below. Code assembles the line from `IssueMeta` (`renderIssueFactsLine`), suffixed "(live, fetched from Jira just now)". No code path reads indexed chunk text into the facts line. The generator prompt is unchanged.
2. Empty values: `null` assignee → "Unassigned", `null` resolution → "Unresolved", `null` priority → "not set". An absent priority/resolution/assignee/updated segment is omitted. Nothing is guessed (AC-4 green; fixture absent priority → no `Priority:` segment).
3. Assignee: `toJiraIssue` reads only `fields.assignee.displayName`. `emailAddress` is never referenced in src (the mutant proves the arm would catch it).
4. Failure on an indexed key: miss, error and timeout each push exactly one `keyMetaFailLine` per key. The pinned indexed chunks survive. The facts fetch goes through the same `fetchIssueLive` with the shared `legStart`, so `min(LIVE_FETCH_TIMEOUT_MS, leg time left)` still bounds it. There is no new budget class.
5. No fetcher: `fetchIssueLive` returns `skipped` → no line. AC-7 deep-equals the generator result.
6. Non-key questions: the `namedKeys.length === 0` branch is untouched. AC-6 deep-equal holds.
7. AC-9: as above, observed via a fake `fetchImpl` URL capture. The other two fetchers (`summary,description,comment,labels,issuetype` and `summary,labels`) are byte-unchanged in the diff. None of them requests a meta field, so the shared `toJiraIssue` maps no meta onto their issues (`"x" in fields` guard).

### Monotonicity

There is no clear-list, mutual-exclusion or last-writer-wins arm in this diff. The facts / meta-fail outcomes are exclusive per key by construction (one `fetchIssueLive` result → one branch). A failed fetch can never produce a facts value. A successful fetch can never produce the fail line.

### Findings

1. MEDIUM (non-blocking, follow-up candidate). The generator never sees the live facts. The facts line is prepended to the answer, but the model gets only the pinned/vector chunks, and its prompt tells it to note what is missing. A real model may therefore still end with "status/assignee/priority are not in my context" right after a live facts line that states them. The answer would contradict itself. The plan deliberately keeps the prompt out of scope, and the stubbed-generator ACs cannot observe this, so it does not block. Suggested follow-up (own S ticket): hand the code-built facts line to the generator as a labelled context item, or suppress the "missing" note for those fields when the facts line is present.
2. LOW. The `Status` segment is always emitted when any meta exists. If the fetch carried meta but no usable `status` (field absent, or malformed `{name}`), the line says "Status: not set" rather than omitting the segment. The plan allows "omitted or said plainly ('not set')", so this conforms. It is only slightly inconsistent with the other four fields, which are omitted when absent. Real Jira always returns status when it is requested.
3. LOW. If an indexed key's facts fetch succeeds but carries no meta at all (`renderIssueFactsLine` → null), no facts line and no could-not-fetch line appear. The real one-issue fetcher always requests the five fields, so in practice this needs a pre-#3307-shaped fetcher. Noted for completeness.
4. LOW (observation, accepted by plan). Indexed named keys used to make zero Jira calls. They now make one bounded fetch each. That adds up to 5 s per key and 10 s per question, worst case, to exact-key answers. An indexed key's slow facts fetch can also spend leg budget that a later unindexed key in the same question needed, which turns it into a timeout line. This stays inside the existing per-fetch and per-leg boxes, as the plan states.
5. INFO. `tests/key-lookup.test.ts` multi-key (b) was rewritten from "exactly ONE fetch, for the unindexed key only" to "one fetch each". This is the intended #3307 behaviour change (plan intent item 2), not a weakened test. The new arm also asserts that the indexed key's pins carry index ids, not `live:` ids, so it is stricter on the pin source.

### Named-risk notes

`node hooks/named-risk-notes.mjs list --task 3307` (run from this worktree) printed one note:
`NOTE nr-3307-stale-indexed-as-current read the actual diff and confirm the facts line is assembled by code from the live fields, labelled live, and that no prompt/code path presents indexed body text as current status`

DISPOSITION nr-3307-stale-indexed-as-current observed-in-diff: `renderIssueFactsLine(key, meta)` in src/knowledge/service.ts builds the line only from the fetched `IssueMeta` and suffixes "(live, fetched from Jira just now)". On an indexed key it is fed by a separate live `fetchIssueLive` call, never by `getChunksBySource` text. The indexed-key failure line explicitly says "the summary below is the indexed copy, which may be stale". The generator prompt is unchanged, and the sync body (key, summary, description, comments) carries no status field. AC-3 (stale-embedding indexed body vs different live values) and AC-5 (no value on failure) are green at head and red at base. Residual: the model's own retelling of indexed prose is not covered by the stubbed ACs; see finding 1.
