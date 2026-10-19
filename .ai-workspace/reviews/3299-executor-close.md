# 3299 executor close — round 2

DISPATCH-NONCE:OR-NONCE-db7a7bc628b2a58a

Branch `3299-key-lookup`, head `0b3c3c8` (this file committed with it). Round 1's
uncommitted work (keyLookup module, service funnel, env wiring, suite AC-2 block,
fixtures incl. the parity receipt recorded at `6873485`) was reviewed and continued;
round 2 added the AC-3..AC-11 both-ends arms, fixed one test-authoring defect
(handler keys written `DEMO_900` instead of `"DEMO-900"`, which made every stubbed
live fetch answer null — caught by the suite itself, not by review), and produced
the RED-at-base receipt.

## AC table (commands run from the worktree root; jest output redirected to tmp/suite-logs/)

| AC | command | exit |
|----|---------|------|
| AC-1 | `npm run typecheck && npm test` | typecheck 0; `npm test` 1 in THIS session only: the ambient `ANTHROPIC_MODEL` override (design #18/#51: env wins over `DEFAULT_MODEL`) makes the pre-existing `tests/generate.test.ts` default-model assertion see the override. Not from this diff (no llm/modelConfig change). With the override emptied for the subprocess — `ANTHROPIC_MODEL= npm test`, empty = unset per `resolveModel`'s own contract — **0**, 65 suites / 678 tests passed (tmp/suite-logs/full-suite.log) |
| AC-2 | `npm test -- tests/key-lookup.test.ts -t extraction` (run as `npx jest tests/key-lookup.test.ts -t extraction`) | 0 — 7 passed (tmp/suite-logs/ac-extraction.log) |
| AC-3 | `npx jest tests/key-lookup.test.ts -t "repro shape"` | 0 at head (tmp/suite-logs/ac-repro shape.log); RED at base — see receipt below |
| AC-4 | `npx jest tests/key-lookup.test.ts -t indexed` | 0 — 7 passed (tmp/suite-logs/ac-indexed.log) |
| AC-5 | `npx jest tests/key-lookup.test.ts -t live` | 0 — 2 passed (tmp/suite-logs/ac-live.log) |
| AC-6 | `npx jest tests/key-lookup.test.ts -t "not found"` | 0 — 1 passed (tmp/suite-logs/ac-not found.log) |
| AC-7 | `npx jest tests/key-lookup.test.ts -t "must-not-fire"` | 0 — 5 passed (tmp/suite-logs/ac-must-not-fire.log) |
| AC-8 | `npx jest tests/key-lookup.test.ts -t parity` | 0 — 1 passed, 7 receipt questions ≥ 6 (tmp/suite-logs/ac-parity.log) |
| AC-9 | `command grep -rnE "globalThis\.fetch\|new Anthropic\|@anthropic-ai/sdk\|\.env" tests/key-lookup.test.ts` (unescaped form, fenced block in the plan) | 1 — zero matches |
| AC-10 | `npx jest tests/key-lookup.test.ts -t multi-key` | 0 — 3 passed (tmp/suite-logs/ac-multi-key.log) |
| AC-11 | `npx jest tests/key-lookup.test.ts -t timeout` (fake timers) | 0 — 2 passed (tmp/suite-logs/ac-timeout.log) |

## AC-3 RED-at-base receipt (plan's temporary-worktree method)

Command (run from the worktree root; `tmp/base-6873485` is a temporary second
worktree checked out at the branch point, suite + fixtures copied in untracked,
dependencies already installed there):

```
(cd tmp/base-6873485 && npx jest tests/key-lookup.test.ts -t "repro shape" > ../../tmp/red-at-base.log 2>&1)
```

exit 1 — the key-not-in-context assertion fails (not an import error; the suite
imports only base-existing modules statically and reaches the new module via a
lazy `require` that this arm never executes):

```
expect(received).toContain(expected) // indexOf

Expected value: "jira:DEMO-673"
Received array: ["jira:DEMO-680", "jira:DEMO-674", "jira:DEMO-675", "jira:DEMO-676", "jira:DEMO-677", "jira:DEMO-678", "jira:DEMO-679", "jira:DEMO-681", "jira:DEMO-682", "jira:DEMO-683", …]

  315 |     expect(genCalls.length).toBe(1);
  316 |     const sources = genCalls[0].chunks.map((c) => c.source);
> 317 |     expect(sources).toContain("jira:DEMO-673");
      |                     ^

at Object.<anonymous> (tests/key-lookup.test.ts:317:21)
```

At head the same command exits 0 with `sources[0] === "jira:DEMO-673"`.

## Variant table (observed values from the real runs above)

| variant | direction | expected | observed |
|---------|-----------|----------|----------|
| "Can you extract Jira Demo 673?" @ base 6873485 | must-fire (RED) | DEMO-673 absent from context, assertion fails | exit 1, `toContain("jira:DEMO-673")` failed, neighbours filled the top-12 (tmp/red-at-base.log) |
| "Can you extract Jira Demo 673?" @ head | must-fire (GREEN) | DEMO-673 pinned first, cited first | exit 0, chunks[0]/citations[0] = jira:DEMO-673 (tmp/suite-logs/ac-repro shape.log) |
| `DEMO-673` / `demo-673` hyphenated, no context word | must-fire | canonical DEMO-673 | exit 0, 7/7 extraction arms passed |
| `Demo 673` / `demo673` with context word before | must-fire | canonical DEMO-673 | exit 0 |
| `Demo 673` / `demo673`, no context word | must-not-fire | [] | exit 0 |
| "Can I demo 2 volunteers to review the doc?" | must-not-fire | 0 keys, 0 fetches, 0 pins, plain vector context | exit 0, ids/sources equal retrieve() (arm 2) |
| "I need to demo 3 tickets for the jira talk" (context AFTER) | must-not-fire | 0 keys, 0 fetches, 0 pins | exit 0 (arm 3) |
| bare "673" / unconfigured "ABC-673" | must-not-fire | nothing extracted | exit 0 (arms 4–5) |
| indexed key, Slack + Telegram ends | must-fire | pinned source first in both channel payloads | exit 0, 7/7 indexed arms passed |
| unindexed key, fetcher stub | must-fire | 1 fetch, ≤3 live chunks, says live, not indexed | exit 0 (re-ask re-fetches) |
| fetcher returns null | must-not-fire (no substitute) | honest miss naming key, 0 citations, 0 generator calls | exit 0 |
| never-resolving fetch, 1 key | must-not-fire (no hang) | resolved past 5 s, /timed out/i, no neighbours | exit 0 |
| never-resolving fetches, 2 keys | must-not-fire (no hang) | resolved by 10 s leg bound, both keys named | exit 0 |
| 4 unindexed keys | must-not-fire (cap) | exactly first 3 fetched, in order | exit 0 |
| 7 key-free questions vs 6873485 receipt | parity | same ids/sources/order, scores ≤ 1e-6 | exit 0 |

Red control (exercised): the AC-3 base run above IS the suite's central
assertion failing — quoted verbatim, exit 1. A second, incidental red was
exercised during development: the `DEMO_900` handler-key typo made the live arm
fail (`genCalls.length` expected 1, received 0) before the fix.

## Carried notes honored

- Named risks `3299-receipt-memorization` and `3299-word-context-guard` stay
  named (see src/knowledge/keyLookup.ts header comment) — for the execution
  review to decide by reading the diff. The parity receipt is data recorded at
  base (round 1, `recordedAt: 6873485`), compared — not re-derived — at head.
- Live-leg composition is named in the diff (src/knowledge/service.ts,
  `answerWithKeyLookup` comment: SEQUENTIAL fetches in first-mention order, each
  budgeted min(per-fetch bound, remaining leg time)) and here: sequential with a
  whole-leg deadline.
- Project prefixes match case-insensitively; the emitted key uses the configured
  list's OWN casing (keyLookup `canonical` map; asserted in the extraction arms
  `ops-42 → OPS-42`, `demo-43 → demo-43` for a lowercase-configured list).

Executor-close: draft PR opened on ziyilam3999/monday-bot (base master, title
"3299: exact issue-key lookup (pin keyed issue, bounded live fetch)") carrying
commit 0b3c3c8 — implemented the exact-key lookup leg per plan round 3, all 11
binary ACs green at head with the RED-at-base receipt quoted above.

## Round 3 (privacy rename) — 2026-10-19

DISPATCH-NONCE:OR-NONCE-5132464b2dcda0d0

Blocker: the repo's public privacy CI ("privacy / denylist") failed because 195
added lines carried the real Jira project-key shape `<KEY>-<digits>` (private work
project). Renamed to the made-up key `DEMO` (the repo's own fixture-key
convention — see `src/jira/jqlFromFilter.ts`) across every file this PR adds or
changes: tests/key-lookup.test.ts, tests/fixtures/key-lookup/*,
src/knowledge/*.ts comments, src/jira/sync.ts comment, and the .ai-workspace
plan/review/close files. Test meaning kept: same shapes, same must-fire and
must-not-fire arms, same counts — `demo` is itself an English word, so the
word-like-key guard arms (AC-2c, AC-7 arms 2–3) still exercise the class; the
`forget-673` gluing arm became `demon-673 is not a key` (word("demon") ≠ "demo",
same token-boundary class). In prose, the real key is referred to as "the project
key"; the plan's quoted operator stone now says "the operator's original key
question" (dispatch-authorized rendering).

Parity receipt: the jest hash-stub embedder tokenizes `[a-z]+`, so the corpus
rename changed chunk vectors and the frozen AC-8 receipt drifted (post-rename
run: 23/24, only parity failing). The receipt was RE-RECORDED at the base commit
`6873485` with the renamed corpus, using the plan's temporary-worktree method
(`tmp/base-6873485`, renamed suite + fixtures copied in untracked, scratch
recording spec — since neutralized in place, as `rm` is seat-forbidden).
`recordedAt` stays `6873485` because that is where it was recorded. The quoted
RED-at-base receipt arrays further up were recorded pre-rename and renamed in
place; the RED property itself was re-verified post-rename by exit code only
(`npx jest tests/key-lookup.test.ts -t "repro shape"` in the base worktree →
exit 1, log not printed per the tmp/ read ban).

Privacy proofs (step 3 of the dispatch, against the pushed diff
`origin/master...HEAD` at `7088d99`):

- `git diff origin/master...HEAD --unified=0 | command grep -E '^\+' | command grep -c -E 'GET[- ]?[0-9]'` → **0**
- same with `-i` over `get[- ]?[0-9]` → **0 lines** (nothing to justify)

Production-code check: `command grep -rn 'DEMO' src/` finds comments/examples
only (`keyLookup.ts` shape documentation, one `sync.ts` comment, plus the
pre-existing base comments in `jqlFromFilter.ts` / `nlFilterMapper.ts`); no
project key is hard-coded — keys come from configuration (`projectKeys`
argument fed from `JIRA_PROJECTS`, never a literal).

Tests (step 4): `npm run typecheck` → rc=0. Full suite per the round-2
convention (the session-ambient `ANTHROPIC_MODEL` override breaks the
pre-existing `tests/generate.test.ts` default-model assertion — not from this
diff; empty = unset per `resolveModel`'s own contract):
`ANTHROPIC_MODEL= npx jest > tmp/suite-logs/r3-jest.log 2>&1` → rc=0,
**Test Suites: 65 passed, 65 total; Tests: 678 passed, 678 total**
(the plain un-emptied form fails only that one pre-existing test, as in round 2).

Ledger note: the self-append line could not be run — `hooks/3role-ledger.mjs`
does not exist in this worktree, on `master`, or in the main checkout (nor does
`tools/openrouter-briefs/seat-rules.md`); handing that back in the dispatch
report instead of fabricating a row.

Executor-close: PR ziyilam3999/monday-bot#270 head 7088d99 — renamed the real
project key to DEMO everywhere this PR touches, re-recorded the AC-8 parity
receipt at base 6873485 with the renamed corpus, re-verified RED-at-base by exit
code, and re-ran the proofs (diff key-shape count 0 case-sensitive and
case-insensitive; typecheck 0; 65/65 suites, 678/678 tests).
