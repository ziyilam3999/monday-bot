# #3299 execution review, round 3 (scoped: beedc00..131b0e9)

3ROLE_TASK:3299 ROLE:execution-review

Scope: `git diff beedc00..HEAD` only (commits 8f8ddcf, 131b0e9). Round 2 (`3299-execution-review-r2.md`) was NEEDS-WORK with one blocking MINOR finding: after the privacy rename, no test pinned an English word ENDING in the key glued to digits.

## Review

Decision: PASS

### What I checked, and how

1. **The new assertions close the named gap.** `tests/key-lookup.test.ts` gains two lines in the existing `extraction (AC-2)` block, next to the `demon-673` assertion: `extractKeys("nodemo-673 is not a key", PROJECTS)` and `extractKeys("xdemo-673", PROJECTS)`, both expected to be `[]`. Both glue letters BEFORE the key, which is the leading-glue direction round 2 asked for. They use the suite's existing `extractKeys` helper and its `PROJECTS = ["DEMO"]` fixture. The `demon-673` trailing-glue arm is kept, so both glue directions are now covered.
2. **Nothing else changed in tests or src.** `git diff --stat beedc00..HEAD -- src/ tests/` shows only `tests/key-lookup.test.ts | 3 +++` (1 comment line and 2 assertions). The only other file in the range is `.ai-workspace/reviews/3299-executor-close.md`, which is append-only prose. The test count stays 678 because the assertions go into an existing `it` block.
3. **Mutant proof, run by me.** I made a one-line change to the configured-key lookup in `src/knowledge/keyLookup.ts:218`, turning the exact whole-token match (`canonical.get(t.text.toLowerCase())`) into a suffix (`endsWith`) match. This is the regression class round 2 named. Running `npx jest tests/key-lookup.test.ts` gave rc=1, `Tests: 1 failed, 23 passed, 24 total`, and the failure pointed at line 257, the new `nodemo-673` assertion. I put the original line back. `git diff --stat src/` was then empty and `git status` was clean. Before the mutant, the same file passed with rc=0 (24/24).
4. **Full suite and typecheck at 131b0e9, run by me.** `npx jest` (output sent to a scratch log): rc=0, `Test Suites: 65 passed, 65 total`, `Tests: 678 passed, 678 total`. `npm run typecheck`: rc=0. I did not set or unset any override env var.
5. **Named-risk notes.** `named-risk-notes.mjs list --task 3299` printed `NO-NOTES 3299`. No new notes are carried into this round, and the round-1 disposition stands.

### Findings

1. **INFO: what actually stops letter glue.** Letter glue on the left (`nodemo`) is rejected by the tokenizer (letters form maximal runs) together with the exact-token lookup at line 218. It is not rejected by the explicit left-glue check in `matchKeyNumber` (`prev && adjacent(prev, key) && prev.kind !== "other"`). That check can only fire for digit glue such as `3DEMO-673`, and the test file has no such case. The new assertions correctly guard the lookup or tokenizer regression that round 2 named. A mutant that only removes the left-glue line would not turn them red. That is acceptable for this round's scope. A `3DEMO-673` must-not-fire assertion would be optional future hardening.
2. **INFO: the executor-close ledger note.** The executor reports that `hooks/3role-ledger.mjs` is missing from the monday-bot worktree. That is expected: the helper lives in the ai-brain repo. This review's ledger row is appended from there.

### Ship condition

None outstanding. Round 2's only blocking finding is resolved and mutant-verified, jest is 678/678, and typecheck is rc=0.
