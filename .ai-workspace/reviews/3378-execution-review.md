# 3378 execution review (PR 275, head 2768f5e)

Reviewer: execution-review seat (Opus, Agent-tool). I did not write this code or the plan.
Plan: `.ai-workspace/plans/2026-10-23-3378-issue-key.md` (plan-review r2 PASS).

Decision: FAIL

The code fix is correct and the operator's question now gets the ticket's live status. The PR still cannot ship: the repo's required `denylist` check is red on this PR. This review's file carries no key in hyphenated form, so it adds no new hit.

## Blocking finding

**B1. The required `denylist` CI check fails: 34 added lines match the regulated employer-token list.**

- `gh pr checks 275`: `denylist fail`. Branch protection on master lists `denylist` as the only required context. The run log says "a regulated employer token was found on 34 added line(s)". The matched content is withheld.
- I counted the added lines (`6955c64...HEAD`) that hold the project key in hyphenated form, as key + dash + digits, case-insensitive. There are exactly 34: 6 in `tests/key-lookup.test.ts`, 5 in `tests/key-lookup-meta.test.ts`, 23 in the plan file, and 0 in `src/` or `scripts/`. The base has 0 such lines in `src/` and `tests/`. Earlier key-lookup PRs (270, 272) passed `denylist` with neutral `DEMO` fixtures.
- The count match is my inference, since the secret regex is not visible to me. It points at the real project key in hyphenated form as the denylisted shape.
- Remedy for the executor: use a neutral project key such as `DEMO` in the test fixtures and expected values. The verb-collision must-not-fire rows still need a key that is an everyday verb. Pick a neutral one, or keep the config key but assert only `[]` for those rows. Also scrub the hyphenated real key from the plan file. Note that the content is already pushed to a public branch, so a squash merge keeps master clean but the PR branch history still holds it. The orchestrator decides whether that needs more action.

## Binary AC (verified by me at head 2768f5e)

| AC | result | evidence |
|---|---|---|
| AC-1 must-fire | PASS | At head, `npx jest tests/key-lookup.test.ts tests/key-lookup-meta.test.ts` gives 54/54. At base, I took the head tests and base `src/` from a `git archive` copy: 6 failed, and every failure is a new 3378 must-fire case or the 3378 end-to-end case. So it is RED at base and GREEN at head. |
| AC-2 must-not-fire | PASS | `-t "3378 must-not-fire"` gives 14 passed at both base and head. That covers all five r1 false-fire sentences, plus the punctuation forms (`status, of …`, `status - of …`, `status of, …`) and `status of about …`. |
| AC-3 regression | PASS | The test-file diff against `6955c64` has 0 removed lines. Every earlier case passes. |
| AC-4 end-to-end stubbed | PASS | The stubbed fetcher is called once with the target key, and the answer holds the `— Status: In Progress` facts line. It is RED at base (listed in the 6 failures). |
| AC-5 full suite | PASS | `npm run typecheck` exit 0, `npm run build` exit 0, `npm test`: 70 suites, 937/937. |
| AC-6 live replay | PASS (see note) | Output below. |
| AC-7 privacy | local PASS / CI FAIL | `privacy-scan.sh --working` is CLEAN on all 7 changed files and on this verdict. Positive control: a temp file with a home path came back DIRTY (home-path matches=1). The CI `denylist` is red, see B1. |

Extra probes against the head `dist/` build (keys = the configured project only):
- Firing: `.`, `!`, `(…)`, upper case, tab/newline whitespace, and the hyphen form after "status of".
- Not firing: `673's`, `673a`, `statuses of`, `status about`, the cue placed after the number, and `what is <key> 673`.

The implementation is exactly `<status|assignee|priority> <of|for|on> <KEY> <n>`, with only whitespace between. `about` was dropped. Dropping it is narrower than the plan's `[about]` option, which is the safe direction. A test pins the drop.

## Ask vs build

The operator asked, in Telegram, "Hi Monday, what's the status of get 673?" and the bot said it could not find the ticket.

At head, I replayed that exact text through the real `KnowledgeService` with `buildIssueLookupFromEnv`, env loaded via `process.loadEnvFile` from the bot's env file, and an empty-login HOME. Results:
- The key was extracted (project key GET, number 673).
- The direct Jira read returned HTTP 200, status name `in design solution`.
- The answer carries the live facts line `— Status: in design solution`, which matches the direct read. I checked this by grep on the log.

So yes: the operator's exact message now returns the ticket's live status. Two things remain before the operator sees it: B1 must clear, and after merge the running bot needs a rebuild and restart. That last step is out of scope here.

About `facts_line`: the script's `facts_line=` field printed `(none)`. Its regex is anchored at the start of a line. In this run the facts line comes after a "fetched live" prelude sentence on the same first line, because the replay seeds a 1-passage index, so the key goes down the live-fetch path. The facts line is present in `answer_line1`. The AC-6 condition is "the log contains `<KEY> — Status: <S>` matching the direct status", and that holds. So the unreliable field does not change the AC result. Non-blocking: fix the regex to drop the `^` anchor.

Non-blocking: the "created too recently for the 6-hourly sync" prelude sentence comes from the seeded replay index. In production the key is in the real index, so that sentence should not appear.

## Named-risk notes

`node hooks/named-risk-notes.mjs list --task 3378`: run from ai-brain it gives NO-NOTES. Run from this worktree it gives one NOTE.

DISPOSITION 3378-field-phrase-prose-fire observed-in-diff: the arm is exactly `<field> <of|for|on> <KEY> <n>` with whitespace only, and nothing broader (no `about`, no window, punctuation blocks it). Prose such as "priority for <key> 2 hotfixes" still fires. That is the accepted, registered trade-off in the plan's Risks section, not a silent widening.

## Monotonicity

The new arm is OR-ed into the loose-shape gate (`!hasContextWordBefore && !hasFieldPhraseBefore`). It only adds a fire path. It cannot erase the existing jira/ticket/issue/key arm or the unconditional hyphen arm. There is no clear-list or last-writer arm.
