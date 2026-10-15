# Executor close — #3136 Haiku 5.5

DISPATCH-NONCE:OR-NONCE-70597a8010893ba3

Executor-close: draft PR opened to master (see PR table below); model module + all
5 call sites + tests landed and green, AC-1/2/3/4/5/6/8/10 PASS, AC-7 measured and
RED (Haiku 5.5 confident 6-7 vs Haiku 4.5's 9 on the fixed first-25 sample, paired
losses 5 > gains 2, noise floor low at 24/25 self-agreement), AC-9 left for the
orchestrator's post-merge ship tail per plan.

## AC table (measured command + exit code)

| # | Command (measured) | rc | Result |
|---|---|---|---|
| AC-1 | `command grep -rn "claude-haiku-4-5" src scripts tests` | 1 | PASS — zero matches |
| AC-2 | `command grep -rln "claude-haiku-5-5" src scripts` | 0 | PASS — exactly one path: `src/llm/modelConfig.ts`; `command grep -c "ANTHROPIC_MODEL" src/llm/modelConfig.ts` = 2 (override kept) |
| AC-3 | `command grep -rn -E "temperature\s*:" src scripts` | 1 | PASS — zero matches (top_p/top_k also absent, r3 note 3) |
| AC-4 | `npm run typecheck` | 0 | PASS; `env -u ANTHROPIC_MODEL npx jest tests/generate.test.ts` rc=0 (36/36), `env -u ANTHROPIC_MODEL npx jest tests/nlFilterMapper.test.ts` rc=0 (13/13); `command grep -c "claude-haiku-5-5" tests/generate.test.ts` = 1. Full `npm test` is execution-review's. |
| AC-5 | live one-off, default model, `node --env-file=.env -e` (getClient from dist, max_tokens 64, "reply with the single word OK") | 0 | PASS — `model=claude-haiku-5-5 stop=end_turn text_blocks=1` |
| AC-6 | same one-off with `ANTHROPIC_MODEL=claude-haiku-4-5` | 0 | PASS — `model=claude-haiku-4-5 stop=end_turn text_blocks=1` (override still wins) |
| AC-7 | `node --env-file=.env scripts/feature-flow-eval.js --real --limit 25` x3 (4.5 override arm, 5.5 arm twice) | 0/0/0 | **RED** — all runs total=25, zero thrown errors, cost lines on each arm's own rate card, but `confident` 5.5 (6, then 7) < 4.5 (9) AND `none` 5.5 (19, 18) > 4.5 (16) AND paired losses (5) > gains (2) |
| AC-7b | n/a — catalog `reviewed=true` (checked via node, flag only); the main AC-7 path ran | — | n/a |
| AC-8 | `node scripts/feature-flow-eval.js` (after `npm run build`, rc=0) | 0 | PASS — prints "(synthetic dry-run: ZERO model calls, ZERO cost. …)" |
| AC-9 | POST-MERGE (orchestrator, ship tail): on the PRIMARY checkout run `npm run redeploy`; then `command grep -c "^llm-model: claude-haiku-5-5" "<StandardOutPath from the INSTALLED plist — the committed template's `<LOG_DIR>` placeholders must NOT be grepped (r3 note 3); default file name monday-bot.out.log>"` must be >= 1, together with the redeploy script's "Freshness PROVEN" line carrying the merged HEAD sha. The bot was NOT restarted here (executor runs no launchctl). The `llm-model:` line prints the RESOLVED REQUESTED id (env override or the modelConfig default), never `res.model`. | — | orchestrator's |
| AC-10 | `bash ../../../../ai-brain/scripts/privacy-scan.sh --working <each changed file + this file + tmp/pr-body-3136.md>` | 0 | PASS — CLEAN for all; home-folder basename count 0 |

## A/B eval (fixed first-25 sample, `--limit 25`; same 25 issue keys in all three runs, verified)

| Arm | total | confident | none | measured usage (in/out tokens) | Cost on own rate card |
|---|---|---|---|---|---|
| Haiku 4.5 (`ANTHROPIC_MODEL=claude-haiku-4-5-20251001`) | 25 | 9 | 16 | 48,897 / 859 | measured $0.053 (1.0/5.0 per MTok); script projection est-usd=0.06 |
| Haiku 5.5 run A | 25 | 6 | 19 | 6,593 / 1,049 | measured ~$0.0012 uncached (0.10/0.50 per MTok); est-usd=0.01 |
| Haiku 5.5 run B (repeat) | 25 | 7 | 18 | 8,705 / 925 | measured ~$0.0013 uncached; est-usd=0.01 |

- Paired split (4.5 vs 5.5 run A): **gains 2, losses 5** (losses > gains ⇒ RED), both-confident 4 (feature id agreement 4/4), both-none 14.
- Self-agreement, 5.5 run A vs run B (noise floor, the cost of losing the sampling pin): confident/none equal on **24/25** (1 flip); chosen feature id equal on **24/25**.
- The low noise floor (1 flip) means the 4.5→5.5 confident deficit is a real model shift on this sample, not run-to-run variance.
- 5.5 measured input tokens are small because the shared catalog-menu prefix hits the prompt cache (cache reads are excluded from `usage.input_tokens`); cache-hit billing ($0.01/MTok) is not captured, so the 5.5 cost figures are uncached-only — both arms stay far under the plan's $0.10 total budget for the whole verification (~$0.06 all-in, measured).
- No truncation: 5.5 output averaged ~42 tokens/call against the 256 cap, `stop=end_turn` observed on the probe; the plan's raise-the-cap remedy does not apply.

Per-defect captures (issue key → confident/none + feature/flow ids): `.ai-workspace/eval-captures/` (gitignored, never printed; only aggregate counts appear above).

## Environment notes (deviations forced by the dispatch shell, commands otherwise verbatim)

- The dispatch shell exports `ANTHROPIC_MODEL=glm-5.3` and an EMPTY `ANTHROPIC_API_KEY`. Node's `--env-file` never overrides pre-set names, so every `.env`-based one-off/eval was run as `env -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY node --env-file=.env …` (the 4.5 A/B arm sets `ANTHROPIC_MODEL` explicitly and only unsets the empty key). This is the override contract working as designed, not a code change.
- `tests/generate.test.ts`'s default-model assertion requires the same clean env (`env -u ANTHROPIC_MODEL npx jest …`); with the harness's override exported the test would see the override id — expected, the override wins by contract.
- The worktree has no `.env`/catalog (gitignored, live in the primary checkout): relative symlinks `.env` and `.ai-workspace/catalog` were added (both gitignored) so the plan's verbatim commands resolve. Remove them with the worktree at cleanup; nothing was committed.
- AC-9 restart step for the orchestrator (exact): on the primary checkout, `npm run redeploy`, then count `^llm-model: claude-haiku-5-5` lines in the INSTALLED plist's StandardOutPath (resolve the real path, not the `<LOG_DIR>` template) and confirm the redeploy "Freshness PROVEN" sha equals merged HEAD.

## Suites

- `npm run typecheck` rc=0; `npx jest tests/generate.test.ts` rc=0 (36 passed); `npx jest tests/nlFilterMapper.test.ts` rc=0 (13 passed); `npm run build` rc=0. Logs under `tmp/suite-logs/`.
- `tests/generate.prompt-integrity`, `tests/triage.featureFlowEval`, `tests/triage.featureFlowMatcher`, full `npm test`: execution-review's.
