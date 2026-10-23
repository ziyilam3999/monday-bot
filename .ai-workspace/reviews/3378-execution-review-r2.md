# 3378 execution review, round 2 (PR 275, head 6e4776f)

Reviewer: fresh execution-review seat (Opus, Agent-tool), round 2. I wrote neither the code, the plan, nor the r1 review.
Scope: r1 FAILED only on the required `denylist` check. Fix commit 6e4776f swapped fixtures to the neutral DEMO key.
In this file `<K>` stands for the real Jira project key; the key itself is not written here in any form.

Decision: FAIL

The code is still correct and the denylist check is now green. The PR still adds 5 lines that carry the real project key right next to a number in the spaced form (`<K> <n>`). Check (2) of the round-2 brief forbids that "in any form (dash, space or joined)". The fix commit scrubbed the spaced form from the tests and the plan, so the executor treated it as regulated too. It missed these 5 lines.

## Blocking finding

**B1. Five added lines (diff `6955c64..6e4776f`) still hold `<K> <n>` in spaced form.** Counted with `command grep -iE '\b<K> +[0-9]'` over the added lines. Dash form: 0. Underscore form: 0. Joined form: 0. The base `6955c64` has 0 such lines anywhere in the tree.

| file | lines | what |
|---|---|---|
| `src/knowledge/keyLookup.ts` | 3 doc-comment lines (the `FIELD_PREPOSITIONS` comment and the block comment below it) | one quotes the operator's real ticket (`<K>` + its real number), two use small example numbers |
| `.ai-workspace/reviews/3378-execution-review.md` (r1 verdict) | 1 (`## Ask vs build` quote of the operator text) | the real ticket in spaced form; the same file also says "project key `<K>`, number `<n>`", which spells the real ticket out |
| `.ai-workspace/named-risk-notes/3378.content.jsonl` | 1 (the note's condition text) | small example numbers |

Remedy (comment and prose only, no logic change): use `demo <n>` / `<KEY> <n>` in the three `keyLookup.ts` comments, and redact the r1 review and the note text the same way. Then re-run `npm test` and re-check with the same grep. The orchestrator decides whether editing the r1 review and the plan-review note is in scope. If it is not, those 2 lines need an explicit operator waiver. The 3 `src/` comment lines are the executor's own and should be fixed.

Non-blocking: the plan's "DEMO-673 exists ... `key=DEMO-673 http=200`" line now describes a read that was really made against the real key. The neutral-key swap turned a true sentence into an untrue one. Better wording: "the real ticket exists (key withheld)".

## Round-2 checks

| # | check | result | evidence |
|---|---|---|---|
| 1 | `gh pr checks 275` all green | PASS | `build (ubuntu-latest, 20) pass`, `denylist pass` at 6e4776f |
| 2 | no added line holds `<K>` next to a number in any form | FAIL | see B1: dash 0, joined 0, underscore 0, spaced 5 |
| 3 | must-fire / must-not-fire unchanged vs r1 | PASS | `npm run build` rc 0. `npm test` 70 suites, 937/937. Key-lookup tests at head: 54/54. Head tests on base `src/` (`git archive` copy): 6 failed / 48 passed, and the 6 are exactly the five `3378 must-fire` cases plus the 3378 end-to-end case. `-t "3378 must-not-fire"`: 14 passed at both base and head. Test diff `2768f5e..6e4776f` is a pure `<K>`->DEMO/demo key swap: the same sentences and the same expectations. Verb-collision rows still use an everyday verb (`demo`). |
| 4 | `src/` identical between r1 head 2768f5e and 6e4776f | PASS | `git diff 2768f5e 6e4776f -- src/` is 0 lines, so r1's live replay still applies |

## Ask vs build

The operator asked in Telegram for the status of a valid Jira ticket, and the bot said it could not find it. The operator wants that fixed. At this head, the fix works. A question shaped `status|assignee|priority of|for|on <KEY> <n>` now reaches the exact-key lookup. r1's live replay of the operator's exact text, against unchanged `src/`, returned the ticket's live Jira status in the answer's facts line. The build is done. B1 is only a privacy cleanup of comment and prose text.

## Named-risk notes

`node hooks/named-risk-notes.mjs list --task 3378`, run from the PR worktree, gives one NOTE.

DISPOSITION 3378-field-phrase-prose-fire observed-in-diff: `src/` is unchanged from r1. The arm is still exactly `<field> <of|for|on> <KEY> <n>`, joined by whitespace only, with no `about`. Prose that matches this shape still fires, as the plan's Risks section says. That trade-off is registered and accepted, so it is not a silent widening. The test fixtures moved to DEMO and the prose-shaped must-not-fire rows still pass.

## Monotonicity

There is no logic change since r1. The new arm is OR-ed into the loose-shape gate, so it only adds a way to fire. It cannot erase the jira/ticket/issue/key context arm or the unconditional hyphen arm. The diff has no clear-list, mutual-exclusion or last-writer-wins arm.

## Privacy

Paths scanned: the 8 files in `6955c64..6e4776f` plus this verdict. I used `command grep` for the key in dash, underscore, spaced and joined forms. This verdict carries none of them. CI `denylist` passes (the secret-backed needle list).
