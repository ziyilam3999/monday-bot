# #3299 execution review, round 2 (scoped: privacy rename since 4abbd0b)

3ROLE_TASK:3299 ROLE:execution-review

Scope: `git diff 4abbd0b..HEAD` only (commits 7088d99, f8891d9, 26d5ddb, c14cf89). Round 1 (`3299-execution-review.md`) was PASS at 4abbd0b. These commits rename the real Jira project key to the fixture key DEMO after the public privacy CI failed, and reword some prose.

## Review

Decision: NEEDS-WORK

### What I checked, and how

1. **Pure rename, same arms, same counts (`tests/key-lookup.test.ts`).** I exported the file at 4abbd0b and at HEAD. Both have 556 lines, 24 `it`/`test` blocks, 9 `describe`, 81 `expect(`, 38 `toEqual(`, 21 `toBe(`, 1 `.not.`. I applied the key rename to the old file mechanically and diffed it against the new one. The only remaining differences come from my over-broad substitution touching `target` and `getUpdates`, which the executor correctly left alone. Every test name and assertion keeps its shape and must-fire / must-not-fire direction. The one exception is the glued arm in finding 1.
2. **Fixtures.** `repro-corpus.json` is a pure rename (same mechanical-diff method, same artifacts only). `parity-receipt.json` was re-recorded at base `6873485`, as the executor close says. I compared old and new receipts with the content-hash `id` field ignored. Result: 7/7 questions, 0 question-text diffs, 0 result-count diffs, 0 source-order diffs, and a maximum score delta of 5.6e-17 (float noise). Only the hashed chunk ids changed, which is expected because the chunk text changed. Parity meaning is preserved.
3. **Production code hard-codes no key.** `src/` changes are comments only. The only changed code lines (`keyLookup.ts:155`, `:185`) are identical apart from their trailing `//` comments. `extractIssueKeys(question, projectKeys)` gets its keys from `KnowledgeService.issueLookup.projectKeys`. That value is built in `src/knowledge/startup.ts:buildIssueLookupFromEnv` from `env.JIRA_PROJECTS` only. The other DEMO mentions in `src/` are in doc comments or prompt examples that predate this diff (`jqlFromFilter.ts:48`, `nlFilterMapper.ts:234`). None is a key literal used for matching.
4. **Tests and typecheck, run by me at HEAD c14cf89.** `npx jest` (output sent to a scratch log): rc=0, `Test Suites: 65 passed, 65 total`, `Tests: 678 passed, 678 total`, the same totals as round 1. `npm run typecheck`: rc=0.
5. **Glued arm, probed directly.** I ran the HEAD `extractIssueKeys` with project list `DEMO` under node type-stripping. `demon-673 is not a key` gives `[]`. `xdemo-673 is not a key` gives `[]`. `nodemo-673 nope` gives `[]`. `3DEMO-673 nope` gives `[]`. `DEMO-673 yes` gives `["DEMO-673"]`. `jira demo673 yes` gives `["DEMO-673"]`. The implementation is correct in both glue directions.
6. **Named-risk notes.** `named-risk-notes.mjs list --task 3299` printed `NO-NOTES 3299`, so there are no new carried notes to disposition in this round. The round-1 disposition of `3299-word-context-guard` stands; it was renamed in place.

### Findings

1. **MINOR (blocking under this round's "nothing weakened or dropped" bar): the word-glued must-not-fire arm changed direction, and the leading-glue case is no longer pinned by any test.** Round 1's arm glued letters BEFORE the key, so the key was the tail of an English word (the real-key form of `xx<key>-673`). The new arm `demon-673 is not a key` glues letters AFTER the key (`demo` + `n`). The mechanism is the same: the tokenizer's whole-word comparison. The regression it guards against is the mirror image, though:
   - A suffix or `endsWith` style regression, or a regex missing its leading boundary, would match `<prefix>demo-673`. It would not match `demon-673`, because no `-` follows `demo` there. The old arm caught that regression; the new arm passes straight through it.
   - The new arm does catch a `startsWith` regression, which the old arm did not. So this is a swap, not like-for-like.
   - Neither the old nor the new file had the other direction. `grep '[A-Za-z0-9](DEMO|demo|Demo)'` over the HEAD test file finds nothing.
   - The leading-glue case is the one the plan's own example was about (an English word that ends in the real key), and it is the one more likely to happen with the real key.
   - The executor close says the new arm is in the "same token-boundary class". That is true of the mechanism but not of what the test protects.

   **Fix:** keep the `demon-673` arm and add one leading-glued assertion in the same `it` block, for example `expect(extractKeys("nodemo-673 is not a key", PROJECTS)).toEqual([])`. The test count stays 678, and I have confirmed that HEAD code already returns `[]` for it. Optionally, update the plan's AC-1 example to name both directions.
2. **INFO: prior role artifacts were edited in place.** The rename rewrote quoted strings inside `3299-plan-review.md` and the round-1 `3299-execution-review.md`. No verdict, Decision, or DISPOSITION line changed. However, the round-1 hardness-probe list now names `demon-673` where round 1 actually probed the leading-glued form. I have now probed `demon-673` too (it returns `[]`), so the edited claim is true, but the record no longer shows the probe that was actually run. This is privacy-forced and accepted; it is recorded here for provenance.
3. **INFO: the RED-at-base check was re-verified post-rename by exit code only, according to the executor close.** I did not re-run it, because that needs the base worktree under `tmp/`, which is out of bounds for this seat. The parity receipt comparison in check 2 independently shows the base ranking is unchanged under the renamed corpus.

### Ship condition

Apply finding 1's one-line addition, then keep jest at 678/678 and typecheck at rc=0. With that change, this round is a PASS. No other part of the rename needs work.
