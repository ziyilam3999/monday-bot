# 3378 execution review, round 3 (PR 275, head befeaf2)

Reviewer: fresh execution-review seat (Opus, Agent-tool), round 3. I wrote neither the code, the plan, nor the r1/r2 reviews.
Scope: r2 FAILED on 5 added lines holding the real project key next to a number in spaced form. Fix commit befeaf2 redacts them.
In this file `<K>` stands for the real Jira project key. The key is not written here in any form.

Decision: FAIL

The tree is now clean and the code is still correct. All four round-3 checks pass. But the PR's own title and body still carry the real ticket: the title in spaced form (`<K> <n>`), the body in spaced AND dash form (`<K>-<n>`). This repo squash-merges with `squash_merge_commit_title=PR_TITLE` and `squash_merge_commit_message=PR_BODY`. So merging as-is writes the regulated dash-form token into the permanent `master` commit message of a PUBLIC repo. The `denylist` CI check cannot see this: `privacy.yml` scans only the lines a PR adds to files, not PR text or commit messages. History can't be undone without a force-push, so this blocks.

## Blocking finding

**B1. PR 275 title and body hold the real key next to a number. That text becomes the squash commit on master.**

| surface | form | count |
|---|---|---|
| PR title | spaced `<K> <n>` | 1 |
| PR body | spaced `<K> <n>` (twice) and dash `<K>-<n>` (once) | 1 line, 3 hits |

Found with `gh pr view 275 --json title,body` piped to `command grep -iE '<K>\W{0,3}[0-9]'`. The repo setting comes from `gh api repos/ziyilam3999/monday-bot`: `{"squash_merge_commit_message":"PR_BODY","squash_merge_commit_title":"PR_TITLE"}`. Visibility: PUBLIC.

Remedy (no code change, no new commit needed): `gh pr edit 275` to rewrite the title and body with `<KEY> <n>` / `demo <n>` / "the operator's ticket (key withheld)". Then re-check with the same grep, which should give 0. A round-4 reviewer only needs to re-run that grep and confirm the head is unchanged.

Non-blocking, recorded only: the branch commit `2768f5e` has the spaced form in its subject and the dash form in its body. With squash-merge, branch commit messages never reach master. They stay reachable only through the PR's ref, and the hard rules ban rewriting that (no amend or force-push). The operator decides whether that residue needs a waiver.

## Round-3 checks

| # | check | result | evidence |
|---|---|---|---|
| 1 | `gh pr checks 275` all green incl. denylist | PASS | `build (ubuntu-latest, 20) pass`, `denylist pass` at befeaf2 (headRefOid befeaf26...) |
| 2 | `git diff 6955c64 befeaf2` adds no line with `<K>` next to a number in any form | PASS | 448 added lines. `command grep -ciE` gives 0 for each of these: dash `\b<K>-[0-9]`, underscore `\b<K>_[0-9]`, spaced `\b<K> +[0-9]`, joined `\b<K>[0-9]`, any-separator `<K>[^a-z]{0,3}[0-9]{2,}`. `git grep` over the head tree (plan, reviews, risk notes, src, tests, scripts) also gives 0. Positive controls: the same spaced grep over `6955c64..6e4776f` gives 5 (r2's B1 count), and the dash grep over `6955c64..2768f5e` gives 34. So the needle is right and the scrub is real. |
| 3 | must-fire / must-not-fire unchanged vs r1 | PASS | At head, `npm run build` exits 0, and `npx jest` passes 70/70 suites and 937/937 tests. Key-lookup suites at head: 54/54. I also ran the head tests against base `src/` (copy at `6955c64`, built with `git archive`): 6 failed, 48 passed. The 6 are exactly the five `3378 must-fire` cases plus the 3378 end-to-end case, so the new tests are RED at base. `-t "3378 must-not-fire"`: 14/14 pass at both base and head. I normalised both test files at `2768f5e` and at `befeaf2` (`<K>` and `demo` both mapped to one token) and they come out byte-identical. So the test change is a pure key swap: same sentences, same expectations. |
| 4 | `src/` identical between r1 head 2768f5e and befeaf2 apart from comment-only lines in `keyLookup.ts` | PASS | `git diff 2768f5e befeaf2 -- src/` has 3 removed and 3 added lines, all in `src/knowledge/keyLookup.ts`. All are doc-comment lines (`/** ... */` and ` * ...`), and each one only swaps `<K>` for `demo`. No code changed, so r1's live replay still applies. |

## Ask vs build

The operator asked in Telegram for the status of a valid Jira ticket, and the bot said it could not find it. The operator wants that fixed. At this head, the fix works. A question shaped `status|assignee|priority of|for|on <KEY> <n>` now reaches the exact-key lookup. r1's live replay of the operator's exact text, against `src/` logic that has not changed since, returned the ticket's live Jira status in the answer's facts line. The build is done. B1 is only a privacy cleanup of the PR's title and body, which become the master commit message.

## Named-risk notes

`node hooks/named-risk-notes.mjs list --task 3378`, run from the PR worktree, gives one NOTE. Run from the ai-brain root, it prints `NO-NOTES 3378`, because the note lives on this PR branch.

DISPOSITION 3378-field-phrase-prose-fire observed-in-diff: since r1, `src/` has changed only in comments, so the arm is still exactly `<field> <of|for|on> <KEY> <n>`, joined by whitespace only. Prose with that exact shape still fires, as the plan's Risks section says. That trade-off is registered and accepted, so it is not a silent widening. The prose-shaped must-not-fire rows (14) pass at head.

## Monotonicity

There is no logic change since r1. The new arm is OR-ed into the loose-shape gate, so it only adds a way to fire. It cannot erase the jira/ticket/issue/key context arm or the unconditional hyphen arm. The diff has no clear-list, mutual-exclusion or last-writer-wins arm.

## Privacy

Paths scanned: the 9 files in `6955c64..befeaf2` (added lines), the head tree paths listed in check 2, the PR 275 title and body, the commit messages in `6955c64..befeaf2`, and this verdict. I used `command grep` for the key in dash, underscore, spaced, joined and any-separator forms. The file diff scores 0 against positive controls of 5 and 34. The PR text scores 3 hits (B1). This verdict carries none of the forms. CI `denylist` passes (the secret-backed needle list, diff-scoped only).
