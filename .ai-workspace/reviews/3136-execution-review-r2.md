## Review

#3136 execution-review, ROUND 2 (fresh seat; wrote neither the code nor round 1). PR ziyilam3999/monday-bot#267, branch 3136-haiku-55, reviewed at head ccc5e2c (fix commits 51614e7 + ccc5e2c over round-1 review 19ea2a8).
Operator decision stands and is not re-litigated: classifier effort MEDIUM, ship Haiku 5.5.

verdict: NEEDS-WORK

The verdict is NEEDS-WORK for one reason only: the live generator probe on Haiku 5.5 could not be measured. The bot's OAuth client got HTTP 429 four times. The stubbed and offline evidence shows no load-bearing defect in the fix. PASS depends on the live probe: re-run it, and if all 3 runs show `stop=end_turn` at the 8192 cap, the fix is green. An API-key route was tried once and the permission classifier denied it. Per the coordinator, it was not used again.

Named-risk notes: `node hooks/named-risk-notes.mjs list --task 3136` printed `NO-NOTES 3136`. Nothing was carried, so there is nothing to disposition.

## Findings

1. **NEEDS-WORK (process, not a code defect): live probe NOT MEASURED.** I ran `env -u ANTHROPIC_MODEL -u MONDAY_TEST_MODE node /private/tmp/fakehome3136er2/probe.js <wt>/dist <cap> <runs>`. The probe sends the real built `generateAnswer` through the bot's own `getClient()`, wrapping `messages.create` to record stop_reason, output tokens and content blocks. It uses 5 short synthetic chunks and one 3-part how-to question. All 4 attempts got `429 rate_limit_error`:
   - red arm (cap 1024): req_011Cg3bzpa7j2Wm3n5BDBwtJ, req_011Cg3c1JNSoykp2onM5Tz14
   - green arm (cap 8192): req_011Cg3cFpx7T4VxnVimaPLJU, req_011Cg3cHMQx5VTMBx6iNSkhw

   Live spend was $0. Re-run the same command (`8192 3`, then `1024 3`) once the rate limit clears. The green bar is `stop=end_turn` in 3/3 runs.

2. **MEDIUM (non-blocking): a `max_tokens` stop is now visible to the operator only. The Slack user still sees the cut-off text as a normal answer.** I measured this offline with `stubcheck.js`: the client's `messages.create` was replaced with canned replies, and the result went through the built `generateAnswer` and then `formatAnswer`.
   - Canned reply: `stop_reason: "max_tokens"`, a thinking block, then the text `To install, download the installer from the portal [1]. Then open Settings and`.
   - The console gets exactly one line: `[generateAnswer] model reply stopped at max_tokens - the text may be TRUNCATED; do not treat it as a complete answer`.
   - **The Slack user sees** the section text `To install, download the installer from the portal [1]. Then open Settings and` with its citation list. There is no "(cut short)" marker, no retry, and no ellipsis. It looks like a finished answer that stops mid-sentence.

   This meets round 1's remedy as written ("raise the cap ... AND surface `stop_reason` ... at least a `console.warn` counter"). Both halves are done: the cap is 8192 and the warning fires. So this is not a round-1 finding left unfixed, and the fix did not introduce it; before the fix the same text was posted with no warning at all.

   The residual risk now depends on how often 8192 is hit. Round 1 measured the worst real run at 1024+ tokens with no end_turn; its end_turn run used 741 tokens. That makes an 8192 stop very unlikely, but finding 1 has to confirm it. Suggested follow-up ticket, not this PR: on `max_tokens`, append a short "answer was cut short" note to the Slack text.

3. **LOW (note): a whitespace-only `ANTHROPIC_MODEL` still passes through.** `ANTHROPIC_MODEL="  "` makes the generator and mapper send `"  "` (measured). The old scripts' `||` did the same, so this is not a regression. Empty and unset are fixed (see the table below).

4. **LOW (note): a truncated backstop retry replaces a complete first answer.** Case C below: the first reply is a complete refusal with `end_turn`; the retry stops at `max_tokens` and the partial retry text is posted. The `if (retry.length > 0) text = retry` arm predates this PR. The warning names `generateAnswer.backstopRetry`, so it is attributable.

5. **INFO: build-catalog change.** The cap went from 4096 to 8192, and the call now sends `output_config: { effort: CLASSIFIER_EFFORT }` (medium) and calls `warnMaxTokensStop(res, "build-catalog.distiller")` after each reply.
   - Why (the executor's measurement; I did not re-run it, because it is a 306-page live run): with default thinking, 4096, 8192 and 16384 all hit the cap with no JSON. With medium effort and 8192, 3/3 runs ended with `end_turn`.
   - This is the same class as plan risk-5 and follows the operator's leg-2 effort decision. A truncated catalog reply still fails loudly ("no JSON object"), and now it warns first.

6. **INFO: every call site is covered.** `command grep -rn -E "max_tokens|stop_reason" src scripts` finds exactly 5 `messages.create` sites that set `max_tokens`. Each one calls `warnMaxTokensStop` with its own name:

   | file | call-site name |
   |---|---|
   | `src/llm/generate.ts` | `generateAnswer`, and `generateAnswer.backstopRetry` for the retry |
   | `src/jira/nlFilterMapper.ts` | `nlFilterMapper.buildLlmFilterMapper` |
   | `scripts/feature-flow-eval.js` | `feature-flow-eval.complete` |
   | `scripts/build-catalog.js` | `build-catalog.distiller` |
   | `scripts/backfill-namespaced-labels.js` | `backfill.featureFlowMatcher` |

   - No site is exempt.
   - The other model-adjacent files (`src/catalog/types.ts`, `src/triage/featureFlowMatcher.ts`, `src/triage/selectBackfillClassifier.ts`) only mention `create` in doc comments or receive an injected `complete`. `src/index.ts` only logs `resolveModel()`.
   - The warning reads only `stop_reason` and the site name: the format string holds no reply text, no request and no credential. A held-out `warnMaxTokensStop(undefined, ...)` does not throw.

Monotonicity checklist:
- **`resolveModel`:** a non-empty `ANTHROPIC_MODEL` is the stronger claim and still wins (measured `set-4-5`). Empty and unset are now the same weaker claim and fall to the default, and neither can erase a set value.
- **`warnMaxTokensStop`:** a pure observer with no erase path.
- **Backstop `text = retry` (finding 4):** a last-writer arm that predates this PR. The new warning makes the overwrite visible, but does not prevent it.

## Round-1 finding table (red at 19ea2a8, green at HEAD ccc5e2c)

| # | finding | red command (19ea2a8) | rc | red observed | green command (HEAD) | rc | green observed |
|---|---|---|---|---|---|---|---|
| 1 | HIGH: generator 1024 cap truncates on Haiku 5.5, stop_reason unchecked | `git show 19ea2a8:src/llm/generate.ts \| command grep -n -E "MAX_TOKENS =\|stop_reason\|warnMaxTokensStop"` | 0 | only `5:const MAX_TOKENS = 1024;`, no stop_reason read | `command grep -n "const MAX_TOKENS" dist/llm/generate.js` after `npm run build` (rc 0); `stubcheck.js` case A | 0 / 0 | `MAX_TOKENS = 8192`; a stubbed max_tokens reply fires the `[generateAnswer] ... TRUNCATED` warning (Slack view: finding 2) |
| 1-live | real-size generator probe on Haiku 5.5, x3 | `probe.js <dist> 1024 3` | 2 | NOT MEASURED: 429 (2 request ids, finding 1) | `probe.js <dist> 8192 3` | 2 | NOT MEASURED: 429 (2 request ids, finding 1) |
| 3 | LOW: build-catalog unmeasured | `git show 19ea2a8:scripts/build-catalog.js` | 0 | `max_tokens: 4096`, no effort, no warn | `git diff 19ea2a8 HEAD -- scripts/build-catalog.js` | 0 | 8192 + effort medium + `warnMaxTokensStop` (executor-measured 3/3 end_turn, finding 5) |
| 4 | LOW: empty `ANTHROPIC_MODEL` resolves to `""` | `env ANTHROPIC_MODEL= node -e '...process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5"'` (the 19ea2a8 expression, line 24) | 0 | `""` | `env ANTHROPIC_MODEL= node modelcheck.js <dist> empty` | 0 | `resolveModel="claude-haiku-5-5" generator_sent="claude-haiku-5-5" mapper_sent="claude-haiku-5-5"` |

LOW-4 per path: `modelcheck.js` captures the model id actually sent by the built generator and mapper, with `create` stubbed so there is no network:
- `unset`: claude-haiku-5-5, all three values
- `empty`: claude-haiku-5-5, all three values
- `claude-haiku-4-5`: claude-haiku-4-5, all three values
- `"  "`: `"  "`, all three values (finding 3)

The three scripts get their model only by calling `resolveModel()` with no arguments (`feature-flow-eval.js:95,228`, `build-catalog.js:68`, `backfill-namespaced-labels.js:188`). Their only other `ANTHROPIC_MODEL` mentions are doc comments (`build-catalog.js:21`, `backfill-namespaced-labels.js:39`). So each script resolves exactly as the table shows.

## Regression

- `npm run typecheck`: rc 0.
- `npm run build`: rc 0.
- `env -u ANTHROPIC_MODEL npm test`: rc 0, `Test Suites: 61 passed, 61 total`, `Tests: 609 passed, 609 total`. Round 1 had 600; +9 are the fix's new tests. Log: `tmp/suite-logs/3136-er2-npm-test.log`.
- The gitignored `.ai-workspace/catalog` symlink was moved to `/private/tmp/fakehome3136er2/` for the run and restored afterwards (verified it points to the same target).

## Held-out table

All rows are offline, through the built `dist/`, with replies injected at the client boundary (`stubcheck.js`). None of these variants appears in round 1 or in the executor's tables.

| variant | direction | expected | observed |
|---|---|---|---|
| A: generator max_tokens, thinking block + partial text | must-fire | warning `[generateAnswer]`, text returned | warning fired (1 line); Slack section = the partial text, unmarked (finding 2) |
| B: generator max_tokens, thinking-only (no text block) | must-fire | warning, then fall back to no-context answer | 2 warnings (`max_tokens` + `no text content`); Slack shows the no-context sentence |
| C: complete refusal, then backstop retry stops at max_tokens | must-fire | warning names `generateAnswer.backstopRetry` | `[generateAnswer.backstopRetry] ... TRUNCATED`; retry text posted (finding 4) |
| E1: mapper reply mid-JSON with `stop_reason: max_tokens` | must-fire | warning `[nlFilterMapper.buildLlmFilterMapper]`, degrade path | create_calls=1, warning fired, filter = deterministic floor (`symptoms:["crash-error"]`, `recency:"this-week"`) |
| D: `stop_reason: "stop_sequence"` | must-not-fire | no warning | warns=[] |
| D: `stop_reason: "pause_turn"` / `"refusal"` | must-not-fire | no warning | warns=[] for both |
| D: `stop_reason: null` / missing (`undefined`) | must-not-fire | no warning, no throw | warns=[] for both, answer intact |
| D: `stop_reason: "MAX_TOKENS"` (wrong case) | must-not-fire | exact match only, no warning | warns=[] |
| E2: mapper mid-JSON with `end_turn` | must-not-fire | no max_tokens warning (silent degrade predates this PR) | warns=[]; same floor filter |
| F: `warnMaxTokensStop(undefined, "x")` | must-not-fire | no throw, no warning | threw=false, warns=0 |
| `ANTHROPIC_MODEL="  "` | passes through (old `||` did the same) | `"  "` | `"  "` (finding 3) |

## Privacy

`privacy-scan.sh --working <abs path>` (the ai-brain primary's `scripts/privacy-scan.sh`) was run once for each of 13 files: the 12 files changed since 19ea2a8 (`git diff --name-only 19ea2a8 HEAD`: the executor close file, 3 scripts, 4 src files, the stub, 3 test files) plus this review. Result: 13/13 rc 0, `privacy-scan: CLEAN mode=working`.

Positive control: a sandbox fixture carrying one home-path form gave rc 1, `privacy-scan: DIRTY (home-path matches=1`.

Home-folder basename count (`command grep -c -i`, plain, dash-encoded and underscore forms) over the same 13 files: 0. The same grep on the control fixture: 1.

cairn: `node skills/cairn/bin/cairn-find.mjs "truncat"` -> [T1] 2026-10-08 line 429: "When Haiku is called with a small max-output cap (such as 600), long replies are..." This is the same class: a Haiku output cap that is too small for the reply. Here, on 5.5, default thinking eats the cap, and the fix raises the cap and makes a stop visible.
