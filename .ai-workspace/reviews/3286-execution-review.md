# 3286 execution review — Part A (sync responsiveness)

Reviewer seat: execution-review (Opus, Agent tool), round 1. Reviewed head: b830786 (draft PR ziyilam3999/monday-bot#269).
Plan: `.ai-workspace/plans/2026-10-19-3286-sync-responsive.md` (plan-review r2 PASS). Executor close: `.ai-workspace/reviews/3286-executor-close.md`.
Named-risk notes: `node hooks/named-risk-notes.mjs list --task 3286` printed `NO-NOTES 3286` (nothing carried, no dispositions owed).

## Review

Decision: PASS

Every Part A AC was re-run by this seat, not read off the executor's table. The fix is small (one
`setImmediate` yield per passage plus an initial-sync lifecycle on the shared query funnel), it is
proven non-vacuous against a build of the pre-fix commit, and it does not change index contents or
ranking. The findings below are follow-up material, none blocking.

### AC re-run (this seat, worktree root, after `npm run build`)

| AC | Command | Exit | Observed |
|---|---|---|---|
| AC-1 | `npm run typecheck` | 0 | clean |
| AC-1 | `npm test` | 0 | 64 suites, 654/654 passed (plain shell; ANTHROPIC_MODEL unset here) |
| AC-2 | runner `probe` with SMOKE_FIXTURES unset | 1 | refuse message names SMOKE_FIXTURES + "never falls back to a live ... target" |
| AC-2 | runner `bound` on a build of pre-fix commit fe95580 (exported with `git archive` to scratch, same fixtures, real backend) | 1 | loop max 6296 ms, wakes 2 of ~33 (STARVED), mid-sync query resolvedBeforeSync=false, `dominant-stall: R1` — reproduces the executor's R1 receipt independently |
| AC-3 | `npm test -- tests/sync-responsive.smoke.test.ts -t warming` | 0 | 4 passed (warming / partial-index normal / no-sources old copy / all-rejected sync-failed), 1 skipped |
| AC-3 | `command grep -rn "still warming up" src/` | 0 | 2 hits (service.ts:30, startup.ts:110) |
| AC-4 | runner `bound` and `store`, SMOKE_FIXTURES unset | 1, 1 | both refuse naming the unset fixture target |
| AC-5 | `SMOKE_FIXTURES=tests/fixtures/sync-responsive node scripts/sync-responsive-smoke.js bound` (HEAD, real onnxruntime backend), run twice | 0, 0 | run 1: loop max 264 ms, handler max 221.8 ms, wakes 31/~35; run 2: loop 167.5 ms, handler 21.8 ms, wakes 30/~32; mid-sync query resolvedBeforeSync=true both runs; `bound: PASS` |
| AC-13 | `command grep -rnE "globalThis\.fetch\|new Anthropic\|@slack/bolt\|@anthropic-ai/sdk" tests/sync-responsive.smoke.test.ts scripts/sync-responsive-smoke.js` | 1 | zero matches |

Probe-before-production ordering: `git show --stat` per commit — ca9e9d4 and 18c2879 touch only
`scripts/sync-responsive-smoke.js` + `tests/fixtures/sync-responsive/*`; fe95580 (receipt) touches only
`.ai-workspace/reviews/3286-executor-close.md`; the first `src/` change is d0c3f52. Confirmed.

Part B absent: the diff (`origin/master...HEAD`) touches no `.gitignore`, no store/cache wiring, no
`save`/`load` call site; `store` mode with fixtures set exits 2 "ships with Part B". Confirmed.

### Failure cases tried (scratch harness over `dist/`, real backend, stub fetchers + stub generator)

| Case | Result |
|---|---|
| Query during initial sync, index empty (fetchers delayed 500 ms) | phase `in-flight`, answer = warming-up copy; after `ready`: phase `settled`, normal stub answer |
| Every initial sync throws | phase `failed`, sync-failed copy, 2 error log lines, `ready` resolved |
| One sync throws, the other settles with zero docs | phase `settled`, OLD "couldn't find" copy (finding 2) |
| Jira sync throws mid-batch (malformed issue) after Confluence indexed | phase `settled`, 22 chunks served, one error line |
| Sync never finishes (both fetchers hang) | phase `in-flight` after 1.5 s, warming-up copy, `ready` unresolved (finding 3) |
| One sync hangs, the other throws | phase `in-flight`, warming-up copy |
| Initial sync fails, later `/reindex` succeeds | sync-failed copy before; normal answer after (phase stays `failed`, harmless while index non-empty — finding 4) |
| Second sync started while the initial sync runs (`reindexAll` + `syncConfluence` issued as soon as the first chunk lands) | 496 chunks / 495 unique ids, 3 of 3 runs (finding 1) |

### Index identity with vs without the yield

Full fixture sync on HEAD vs the pre-fix build: 495 = 495 chunks, 70 = 70 sources, id sets equal,
per-source chunk order identical (0 diffs), passage text identical (0 diffs), max vector element
difference 0. `KnowledgeService.retrieve()` (production ranking path, default topK) for 8 questions:
identical ids and scores to 1e-9. Only the GLOBAL interleave of Confluence vs Jira chunks differs (the
two initial syncs run concurrently and now interleave per passage); search sorts by score, so this
does not reach ranking. No passage is dropped or reordered within a source.

The R1 regression test is non-vacuous: copied alone into the pre-fix tree it fails
(`Expected value: "immediate"`, `Received array: []`); on HEAD it passes.

### Findings

1. MEDIUM (pre-existing race, newly reachable; follow-up, non-blocking) — overlapping syncs of the same
   source leave duplicate chunks. On HEAD, initial sync + `reindexAll()` + `syncConfluence()` overlapping
   → 496 chunks / 495 unique ids (3/3 runs). The pre-fix build with the same calls → 810 / 495, so the
   race predates this diff: `VectorIndex.add` checks for a duplicate id BEFORE `await embed` and pushes
   after it, and `startup.ts` has no single-flight guard per source. The yield sits after the push, so
   it does not widen that window. But before this fix the loop was starved for the whole boot sync, so
   an operator `/reindex` could not land mid-sync; now it can. The next sync of that source heals it
   (`removeBySource`). Suggest a follow-up S ticket: single-flight (or queue) syncs per source.
2. LOW — partial initial-sync failure with an empty index serves the old "couldn't find" copy. One source
   rejects and the other settles with zero documents → phase `settled` → `NO_DOCUMENTS_ANSWER`. Plan
   decision 3 says the false copy is never served in an empty state; the code's own comment chooses
   "a partial success settles normally". AC-3's four named cases all pass as written, so this is an edge
   outside the AC, not an AC failure.
3. LOW — an initial sync that never settles shows "still warming up" forever (`ready` never resolves).
   No sync timeout existed before this diff either; out of Part A's scope. A follow-up could add a
   per-sync deadline that settles the phase as `failed`.
4. INFO — `initialSyncPhase` stays `failed` after a later successful `/reindex`. It is consulted only
   when the index is empty, so the only visible effect is a sync-failed copy if a later re-sync also
   indexes nothing.
5. INFO — the first AC-3 jest case drives `noteInitialSyncStarted()` directly rather than through
   `startKnowledgeSources`; this seat's harness covered the real wiring (case 1 above). The fourth case
   does go through `startKnowledgeSources`.
6. INFO — the runner's mid-sync query reports `atDocs=0` because `documentCount` counts finished
   documents while the trigger is the first chunk; the assertion (`resolvedBeforeSync=true`) is still
   the right one.

### Monotonicity checklist (#1590)

- `noteInitialSyncStarted()` moves only `not-started → in-flight`; it cannot downgrade `settled` or
  `failed` (the stronger, terminal claims) back to `in-flight`.
- `noteInitialSyncSettled(allFailed)` is last-writer-wins but is called exactly once, from `ready`
  after `Promise.allSettled`; nothing else writes the phase. `failed` requires total > 0 AND every
  tracked sync rejected, so a partial success can never be erased into `failed`.
- `query()` reads the phase only when `size() === 0`; any indexed document wins over both copies
  (partial beats refusal), so neither copy can mask real content.

### Privacy

`bash scripts/privacy-scan.sh --working <path>...` (ai-brain scanner), one invocation over:
`scripts/sync-responsive-smoke.js`, `src/index/vectorIndex.ts`, `src/knowledge/service.ts`,
`src/knowledge/startup.ts`, `tests/sync-responsive.smoke.test.ts`,
`tests/fixtures/sync-responsive/confluence-pages.json`, `tests/fixtures/sync-responsive/jira-issues.json`,
`.ai-workspace/reviews/3286-executor-close.md`, and this review (pre-privacy-section draft).
Verdict: `privacy-scan: CLEAN mode=working size=408918`.
Positive control (same invocation shape, scratch file seeded in the home-path class from run-time
fragments): `privacy-scan: DIRTY (home-path matches=1, brand matches=0, email matches=0, credential-secret matches=0, scan-cmd-fragment matches=0)`.
