# 3378 execution review, round 4 (PR 275, head 345b39c)

Reviewer: fresh execution-review seat (Opus, Agent-tool), round 4. I wrote neither the code, the plan, nor any earlier review round.
Scope: r3 FAILED only because the PR title and body held the real project key next to a number (the squash commit on master is built from them). The orchestrator has since edited the PR title and body. No code changed.
In this file `<K>` stands for the real Jira project key. The key is not written here in any form.

Decision: PASS

## Round-4 checks

| # | check | result | evidence |
|---|---|---|---|
| 1 | PR 275 title and body hold `<K>` next to a number in no form | PASS | `gh pr view 275 --json title,body` piped to `command grep -ioE` counts. Any separator of up to 3 non-alphanumerics (`<K>[^a-z0-9]{0,3}[0-9]+`, covers dash, space, underscore and joined, any case): 0. Joined `<K>[0-9]+`: 0. The bare word `<K>` in any context: 0. Positive controls with the same needle: the branch commit `2768f5e` message gives 1, and the dash grep over `git diff 6955c64 2768f5e` gives 34, the same as r3. So the needle is the right one and the PR text is clean. |
| 2 | Code tree unchanged since r3's head `befeaf2` | PASS | `git diff --name-status befeaf2 345b39c` shows a single path, `A .ai-workspace/reviews/3378-execution-review-r3.md`. Excluding `.ai-workspace`, the diff is empty. PR headRefOid is `345b39c`. |
| 3 | `gh pr checks 275` all green | PASS | `build (ubuntu-latest, 20) pass`, `denylist pass`. The check-runs API for `345b39c` reports both as completed/success, so they ran on the current head. |

Carried forward from r3, since check 2 shows no code change: `npm run build` exits 0. `npx jest` passes 70/70 suites and 937/937 tests. The five 3378 must-fire cases and the end-to-end case are RED against base `src/` and green at head. The 14 must-not-fire cases pass at both base and head. The added file lines contain the key next to a number in no form.

## Ask vs build

The operator asked the Telegram bot for the status of a valid Jira ticket, the bot said it could not find it, and the operator asked for it to be checked and fixed. A question shaped `status|assignee|priority of|for|on <KEY> <n>` now reaches the exact-key lookup. r1 replayed the operator's exact text live against `src/` logic that has not changed since, and the answer's facts line held the ticket's live Jira status. The build matches the ask. The PR text that becomes the master squash commit no longer carries the real ticket.

## Named-risk notes

Run from the ai-brain root, `node hooks/named-risk-notes.mjs list --task 3378` prints `NO-NOTES 3378`. Run from the PR worktree, it prints one NOTE, which lives on this branch.

DISPOSITION 3378-field-phrase-prose-fire observed-in-diff: `src/` is unchanged since r1 apart from comment lines, so the arm is still exactly `<field> <of|for|on> <KEY> <n>`, joined by whitespace only. Prose with that exact shape still fires, as the plan's Risks section records. That trade-off is registered and accepted, not a silent widening. The 14 prose-shaped must-not-fire rows pass (r3, unchanged code).

## Monotonicity

No logic change since r1. The new arm is OR-ed into the loose-shape gate, so it can only add a way to fire. It cannot erase the jira/ticket/issue/key context arm or the unconditional hyphen arm. The diff has no clear-list, mutual-exclusion or last-writer-wins arm.

## Privacy

Paths scanned: the PR 275 title and body, the `befeaf2..345b39c` diff (one `.ai-workspace` review file, which r3 already scanned), and this verdict. I used `command grep` with the any-separator, joined and bare-word forms, against positive controls of 1 and 34. Result: PR text 0, this verdict 0. CI `denylist` passes at head.

Non-blocking, carried from r3: the branch commit `2768f5e` has the key in its message. A squash merge does not carry branch commit messages into master, and the hard rules ban rewriting that commit. The operator decides whether that residue needs a waiver.
