## Review
DISPATCH-NONCE:OR-NONCE-b14a57d66eae6267
Decision: NEEDS-WORK
verdict: NEEDS-WORK

Task #3136 — plan-review round 1 (fresh seat; plan not authored here). Plan:
`.ai-workspace/plans/2026-10-15-3136-monday-bot-haiku-55.md` at HEAD ed82553 on
branch 3136-haiku-55 (ff-only merge from origin: already up to date).

## Premises re-verified from primary sources

| Premise | Result |
|---|---|
| Old id `claude-haiku-4-5-20251001` at exactly 5 sites, all reading `ANTHROPIC_MODEL` first | VERIFIED — `command grep -rn "claude-haiku-4-5" src scripts tests` returns exactly the 5 named lines (`src/llm/generate.ts:3`, `src/jira/nlFilterMapper.ts:28`, `scripts/feature-flow-eval.js:84`, `scripts/build-catalog.js:67`, `scripts/backfill-namespaced-labels.js:186`). Repo-wide census outside `node_modules`/`.git`/`dist*` finds no other `claude-haiku-*` literal except the stub sentinel `claude-haiku-stub` (`tests/__stubs__/anthropic-sdk.js:65`). Premise exhaustive. |
| Haiku 5.5 price $0.10/$0.50 per MTok at <=100K | VERIFIED — fetched platform.claude.com/docs/en/about-claude/pricing (2026-10-15): standard table "Claude Haiku 5.5 ... $0.10 / MTok for prompts up to 100,000 tokens, $0.50 / MTok"; over 100K $0.50/$2.50; 5m cache write $0.125, 1h $0.20, cache hit $0.01; Haiku 4.5 $1/$5. All match the plan. (The page's $0.05/$0.25 rows are the 50%-off batch table, not standard.) Long-context note confirms Haiku 5.5 is priced by prompt length at the 100K threshold. |
| Haiku 5.5 rejects `temperature` != 1 | VERIFIED — fetched platform.claude.com/docs/en/models/haiku-5-5/migration-guide: "If a request includes temperature, it must be 1 ... Any other temperature or top_p value returns a 400 error". Dropping the field is the documented remedy. |
| `output_config.effort` shape; thinking-on-by-default; thinking counts toward `max_tokens` | VERIFIED — migration guide shows `thinking: {"type":"adaptive"}, output_config: {"effort": "medium"}` and "Thinking tokens count toward max_tokens, so a request with a small max_tokens can stop" + "select blocks by their type field". Installed `@anthropic-ai/sdk` 0.90.0 (`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:712`) types `effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'` — `'low'` legal, no SDK bump needed. |
| #1195 test pins `temperature: 0` | VERIFIED — `tests/generate.test.ts:77-89` (`expect(req.temperature).toBe(0)` at :89). Only test pinning it; `tests/nlFilterMapper.test.ts` has no temperature reference. |
| Restart without executor launchctl | VERIFIED — `package.json:11` `redeploy` -> `scripts/redeploy-local.sh` (its line 106 prints "Freshness PROVEN: live build-stamp sha=... == HEAD ..."); plist template `deploy/launchd/com.monday-bot.plist.template` sets EnvironmentVariables = PATH + NODE_ENV only and StandardOutPath = monday-bot.out.log, matching AC-9's default-log claim. Plan correctly scopes the restart to the ship tail. |
| AC-8 premise (synthetic mode prints ZERO model calls) | VERIFIED by execution after `npm run build` (see held-out row 6): exit 0, counts line `total=3 ... confident=2 none=1` + "(synthetic dry-run: ZERO model calls, ZERO cost...". Format matches AC-7's captured counts line. `--limit` does not exist yet (decision 7 adds it) — correct. |

## Findings

1. **BLOCKER — AC-3 is unsatisfiable under the plan's named changes.** Ran the AC's
   exact command at HEAD: `command grep -rn -E "temperature\s*:" src scripts` returns
   9 lines. Five are the send sites the plan removes (`src/llm/generate.ts:526`,
   `src/jira/nlFilterMapper.ts:263`, `scripts/feature-flow-eval.js:90`,
   `scripts/build-catalog.js:83`, `scripts/backfill-namespaced-labels.js:192`). The
   other FOUR survive every change the plan enumerates and none is named anywhere in
   the plan:
   - `src/triage/growthProposer.ts:5` — doc comment "``temperature: 0`` upstream"
   - `src/triage/featureFlowMatcher.ts:7` and `:58` — doc comments, same phrase
   - `src/jira/nlFilterMapper.ts:10` — doc comment "temperature 0" (coloned in
     context) and, load-bearing, `src/jira/nlFilterMapper.ts:35` — the injectable
     `MessagesCreate` request type declares `temperature: number;` as a REQUIRED
     field; dropping the field from call sites without editing this type fails
     `npm run typecheck`, so the edit is forced — but the comment rewrites are not
     forced by anything, and AC-3 demands "exit 1 (zero matches)".
   Fix (one paragraph in the plan): name these four/five residual lines as in-scope
   (drop the interface field; reword the three triage doc comments to the new
   determinism story), or restate AC-3 as zero matches on a code-only pattern
   (e.g. `temperature\s*:\s*[0-9]` still matches the comments — so naming the lines
   is the clean fix). This is the only change I require before execution.

2. **MEDIUM — AC-7's A/B reads aggregates only; n=25 aggregates can hide per-defect
   regressions and have low power.** `confident_5.5 >= confident_4.5` can pass while
   the two arms disagree harmfully on individual defects (offsetting swaps). Stronger
   cheap check at zero extra cost: both arms already run the same FIXED first-25
   sample (decision 7), so have each run capture per-defect results and report in the
   PR body the paired disagreement split — defects where 5.5 is `confident` and 4.5
   is `none` (gains) vs the reverse (losses) — alongside feature-accuracy per arm.
   Losses > gains is the honest red flag an aggregate inequality cannot show. Not a
   blocker: the directional inequality is still real signal; add the paired split as
   an AC-7 capture requirement.

3. **LOW — AC-7 and AC-8 omit the build prerequisite.** Verified by execution:
   `node scripts/feature-flow-eval.js` in a clean worktree dies with
   `MODULE_NOT_FOUND` (the script requires `dist/triage/...` at lines 36-39;
   `dist-last-good` is empty here and `dist/` does not exist until `npm run build`).
   AC-5 correctly chains `npm run build &&`; AC-7 and AC-8 must too (or the plan
   states one shared prerequisite line), else both ACs fail for a reason unrelated
   to their assertion.

4. **LOW (note) — AC-9's anchored exact-match grep is safe only against the resolved
   requested id.** `^llm-model: claude-haiku-5-5` matches the plan's own cairn lesson
   (date-suffixed served ids) ONLY because decision 6 logs the resolved requested id
   (the literal default), not `res.model`. Executor must not "improve" the log line
   to print the API-returned `res.model`, or AC-9 breaks on a dated suffix.

5. **LOW (note) — `dist-last-good/` is absent in this worktree** (empty dir), so the
   plan's risk row about it carrying the 4.5 id applies to the primary checkout,
   where the wrapper promotes it. No AC gap; recorded so execution-review does not
   chase it here.

Everything else in the closed list checked and clean: exhaustive model-id census
(check 4 — one source of truth achievable; `estimateCost`'s inline 4.5 numbers in
`tests/triage.featureFlowEval.test.ts:104,112` are pure-arithmetic fixtures and
correctly stay), every AC has a red state on master (AC-1/2/3 greps verified red at
HEAD; AC-4's new assertion is red by construction; AC-5/6/7 are live and unrunnable
pre-change), the live smoke (AC-5) proves the served model id via `res.model` with
prefix matching, and the restart is correctly owned by the ship tail via
`npm run redeploy` (no executor launchctl).

## Executor notes

1. When dropping `temperature`, also delete `temperature: number;` from the
   `MessagesCreate` type (`src/jira/nlFilterMapper.ts:35`) and reword the three
   triage doc comments (`src/triage/growthProposer.ts:5`,
   `src/triage/featureFlowMatcher.ts:7,58`) plus `src/jira/nlFilterMapper.ts:10` —
   AC-3's grep hits all of them (finding 1). The stub's comment at
   `tests/__stubs__/anthropic-sdk.js:6` mentions the pin too; tests are outside
   AC-3's scope but update it for accuracy.
2. Chain `npm run build` before AC-7 and AC-8 invocations (finding 3).
3. Capture per-defect results in both AC-7 arms and report the paired
   gain/loss split in the PR body (finding 2).
4. Log the resolved requested id on the `llm-model:` line, never `res.model`
   (finding 4).
5. Do not touch `.env`; AC-5/6/7 one-offs use `--env-file=.env` as written.

## Held-out probes (run at HEAD ed82553, pre-change; "expected" = post-change pass state)

| variant | direction | expected | observed |
|---|---|---|---|
| `command grep -rn "claude-haiku-4-5" src scripts tests` | old id gone (AC-1) | exit 1 | exit 0 — exactly the 5 named sites (red confirmed) |
| `command grep -rn "20251001" src scripts tests` | dated id fully gone | exit 1 | exit 0 — same 5 sites |
| `command grep -rln "claude-haiku-5-5" src scripts tests` | single source (AC-2) | exactly 1 path | 0 paths (red confirmed) |
| `command grep -rn "claude-haiku" src scripts tests` minus 4-5 hits | literal census | only the new module + `claude-haiku-stub` sentinel | only `tests/__stubs__/anthropic-sdk.js:65` sentinel — plan's exception list is accurate |
| `command grep -rn -E "temperature\s*:" src scripts` | no sampling field (AC-3) | exit 1 | 9 matches; 4 survive the plan's named edits (finding 1 — the blocker) |
| `command grep -rn -E "top_p|top_k" src scripts` | no other sampling params | exit 1 | exit 1 (already clean today) |
| `node scripts/feature-flow-eval.js`, no `dist/` built | script runs (AC-8) | exit 0 + "ZERO model calls" | MODULE_NOT_FOUND (dist required); after `npm run build`: exit 0, `total=3 ... confident=2 none=1`, ZERO-model-calls line (finding 3) |
| `ANTHROPIC_MODEL=claude-haiku-4-5` live one-off (AC-6 shape) | override wins | `model=claude-haiku-4-5...` | NOT RUN — live credentialed call; out of a read-only plan-review's scope, left to the executor's AC-6 |
| `command grep -rho "claude-[a-z0-9.-]*" dist-last-good` | promotion copy state | 4.5 id on primary checkout until wrapper promotes | dist-last-good empty in this worktree (finding 5) |

cairn: `node skills/cairn/bin/cairn-find.mjs "haiku"` -> [T1] 2026-10-08 run-scratch
4236cea4:165 "When a result's model name can carry a date suffix (for example a dated
alias of ...)" — corroborates the plan's prefix-match live-smoke design (and finding 4);
also 2026-10-08 :429 "When Haiku is called with a small max-output cap (such as 600),
long replies are [truncated]" corroborates the effort-low/cap risk row.
