# 3324 execution-review: Slack entities un-escaped at the Slack->Telegram boundary

Plan: `.ai-workspace/plans/2026-10-22-3324-amp.md` · PR ziyilam3999/monday-bot#274 · branch 3324-amp · reviewed head 3a5ac0507e · 2026-10-22

## Review

Decision: PASS

Carried named-risk notes: `named-risk-notes.mjs list --task 3324` printed `NO-NOTES 3324`, so no registered note needs a disposition. I still dispositioned the plan-review's prose named-risks below.

### What I verified myself (not from the executor's note)

- **Diff scope.** `git diff origin/master...HEAD`: one production file (`src/telegram/formatter.ts`, +19/-1), tests in `tests/telegram.test.ts`, plus plan / plan-review / executor-close artifacts. Fits size S (one code file, no new smoke).
- **The decode.** `decodeSlackEntities` is three plain global replaces (`&lt;`, `&gt;`, then `&amp;` last) over the whole context-element string, applied once, after `stripMrkdwn`, for every context element in `renderTelegramReply`. No corpus-specific casing. It is the exact inverse of `sanitizeTitle` (`src/slack/formatter.ts:73`): after encoding, every `&` starts `&amp;`/`&lt;`/`&gt;`, so `&lt;`/`&gt;` hits are always real encoded chars, and amp-last stops a literal `&lt;` title from being decoded twice.
- **Every render path.** `formatAnswer` (`src/slack/formatter.ts:203`) is the only producer of `context` blocks in `src/`. `renderTelegramReply` is the only Telegram render of citation lines (`src/telegram/adapter.ts:196`). The other Telegram `sendMessage` (adapter:184) sends the static help card. `formatAskDefectsBlocks` emits `section` blocks and is only wired into the Slack adapter. No title reaches Telegram any other way.
- **Head, run by me:** `npx jest`: 69/69 suites, 777/777 tests pass. `npm run typecheck`: rc 0. `npm run build`: rc 0. The working tree stayed clean.
- **RED on master, run by me:** I extracted origin/master with `git archive` into a scratch dir outside the worktree and copied in the head `tests/telegram.test.ts`. Result: 6 failed / 38 passed (AC-1..AC-6 fail with entities visible). AC-7 passes on master, as expected for a Slack-unchanged golden.
- **PR checks:** `build (ubuntu-latest, 20)` and `denylist` both SUCCESS at head 3a5ac05. The PR is still a draft.

### My own counterexamples (scratch copy of head, probe test, 6/6 pass)

1. Double-escaped and odd inputs all round-trip byte-identically: `&amp;amp;`, `&amp;`, `&amp;lt;`, `&&lt;`, `&ampx`, `&amp` (no semicolon), `&lt`, `&#38;`, `&#60;`, `&#x26;`, `&quot;`, `&nbsp;`, `&LT;`, `&AMP;`, `a&gt;&lt;b`, `&;`, `&&&`. Numeric and uppercase entities are never decoded.
2. Markup title `*bold* _it_ [x](y) \`code\` ~s~ <https://e.example|click> <!channel>` renders as one line with no `*`. The other characters stay literal, which is safe because the transport sends plain text with no parse_mode.
3. Fuzz: 5000 random strings over a hostile alphabet (`& < > ; a m p l t g # 3 8 * ~ \` _` ...), used as both source and heading. In every case the rendered line equals the input with only `* ~ \`` removed (that removal is the pre-existing `sanitizeTitle` strip).
4. Long titles at 4000/4080/4090/4095/4096/4100/9000 chars, 3 citations each: no entity survives, the `splitMessage` concat matches the original exactly, and every part is at most 4096 chars.
5. Answer body with literal `&amp;` / `&lt;tag&gt;` is not decoded.
6. 12 citations (two context blocks, because of Slack's chunking at 10): all 12 lines are decoded.

### AC table cross-check (executor close note vs observed)

| AC | Executor | Observed | Match |
|---|---|---|---|
| AC-1..AC-6 | PASS | PASS at head, FAIL on master | yes |
| AC-7 | PASS (passes on both) | PASS on both | yes |
| AC-8 | PASS (typecheck not run) | jest 777/777, typecheck rc 0, build rc 0, RED 6 fail | yes, gap closed by me |

### Findings

1. **LOW (evidence gap, closed).** AC-8 names `npm run typecheck`, but the executor did not run it and said so honestly. I ran it at head and it exits 0. No action needed.
2. **INFO (env-dependent test, not this diff).** The executor reported `tests/generate.test.ts` failing because the default model resolved differently in its environment, and saw the same failure on master. In my environment the full suite is 777/777 green. The failure is unrelated to this change.
3. **INFO (pre-existing, out of scope).** `sanitizeTitle` does not strip newlines. A title containing `\n` would split one citation across two Telegram lines on both master and head. This diff does not change that, so it is not a regression. File a follow-up only if it is ever seen in the field.

### Named-risk dispositions (plan-review prose notes)

- Plan-review note 2 (stub-tuned decode): addressed. I read the decode and it is a plain global replace over the full element string. The 5000-case fuzz above confirms it is not memorized to the AC corpus.
- Plan-review note 3 / plan B4 (a future parse_mode would make restored `<`/`&` unsafe): observed-in-diff. The transport still sends with no parse_mode, and the JSDoc on `decodeSlackEntities` records the reasoning. The risk stays named for any future parse_mode change.
- Plan B5 (pre-escaped upstream title): not-applicable to this diff. The render contract is byte-identity, which probe 1 confirms: a stored `&amp;` shows as `&amp;`. Any ingestion gap would get its own ticket.

### Monotonicity checklist

There is no clear-list, mutual-exclusion or last-writer-wins arm in this diff. The decode is one pure string function, so the checklist does not apply.

Size-S waiver: plan-review was not waived (round-1 PASS on file). The diff fits S anyway.
