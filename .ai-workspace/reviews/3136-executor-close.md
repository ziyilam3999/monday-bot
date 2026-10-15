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

## Leg 2: effort medium (2026-10-15, operator retry decision)

DISPATCH-NONCE:OR-NONCE-aab1a9898da84175

Executor-close: PR #267 leg 2 — classifier effort low→medium via one
CLASSIFIER_EFFORT constant in src/llm/modelConfig.ts (all three call sites read it,
ANTHROPIC_MODEL override untouched), classifier output caps raised 256/512→2048 under
the plan's risk-5 truncation remedy, Haiku 5.5 arm re-run twice on the same fixed
first-25 sample; measured only, no ship decision (that is the orchestrator's).

### Blocker hit and remedy (measured)

Medium effort reasons BEFORE the text block and the tokens count toward `max_tokens`:
a probe at `max_tokens: 256` returned `stop=max_tokens` with a single thinking block and
ZERO text, so the matcher threw "no JSON" on the first defect (run aborted rc=1, no
partial capture). Plan risk 5 names the remedy ("if a route still truncates, raise its
cap — a one-line change inside the same PR"): probe at 2048 returned `stop=end_turn`,
out=529 tokens (~500 thinking + 64-char JSON). Caps raised: both script wrappers
256→2048, nlFilterMapper 512→2048. Post-raise both eval runs completed with zero
thrown errors.

### AC table — leg 2 (measured command + exit code)

| Check | Command (measured) | rc | Result |
|---|---|---|---|
| effort via one constant | `command grep -rn 'effort: "' src scripts` | 0 | PASS — only remaining literal is the `"low" \| "medium" \| "high"` TYPE union in nlFilterMapper.ts:38; `CLASSIFIER_EFFORT` defined once in `src/llm/modelConfig.ts` (=1) and referenced at all 3 call sites (3/2/2) |
| override kept | `command grep -rn 'ANTHROPIC_MODEL' src/llm/modelConfig.ts` | 0 | PASS — 4 matches (resolveModel + doc), override contract unchanged |
| truncation remedy | `npm run build` then probe `max_tokens: 2048, effort medium` | 0 | PASS — `stop=end_turn` text block present; both eval runs rc=0, zero thrown errors |
| suites | `npm run typecheck`; `env -u ANTHROPIC_MODEL npx jest tests/generate.test.ts`; `env -u ANTHROPIC_MODEL npx jest tests/nlFilterMapper.test.ts` | 0/0/0 | PASS — 36/36 and 13/13 (logs in tmp/suite-logs/*-leg2.log) |
| eval run A | `env -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY node --env-file=.env scripts/feature-flow-eval.js --real --limit 25` (after `npm run build`) | 0 | total=25 confident=16 none=9, zero thrown errors |
| eval run B | same command, repeat | 0 | total=25 confident=13 none=12, zero thrown errors |
| same sample | keys of all three captures compared in node | 0 | PASS — A == B == the leg-1 4.5 capture on all 25 issue keys |
| privacy | `bash ../../../../ai-brain/scripts/privacy-scan.sh --working` over all 5 changed files + this file | 0 | PASS — CLEAN, home-folder basename count 0 |

### A/B eval — leg 2 (fixed first-25 sample, same 25 keys as leg 1; 4.5 arm reused, not re-run)

| Arm | total | confident | none | measured usage (in/out tokens) | Cost (5.5 card 0.10/0.50; 4.5 card 1.0/5.0) | avg out tokens/call |
|---|---|---|---|---|---|---|
| Haiku 4.5 (leg-1 capture, reused) | 25 | 9 | 16 | 48,897 / 859 | $0.053 | 34.4 |
| Haiku 5.5 effort MEDIUM run A | 25 | 16 | 9 | 45,057 / 2,927 | ~$0.0060 uncached (est-usd=0.01) | 117.1 |
| Haiku 5.5 effort MEDIUM run B | 25 | 13 | 12 | 10,369 / 2,948 | ~$0.0025 uncached (est-usd=0.01) | 117.9 |
| (leg 1, effort LOW run A/B for contrast) | 25 | 6 / 7 | 19 / 18 | 6,593/1,049; 8,705/925 | ~$0.0012; ~$0.0013 | ~42 |

- Paired split vs Haiku 4.5, run A: **gains 8, losses 1** (gains > losses), both-confident 8 (feature-id agreement 8/8), both-none 8.
- Paired split vs Haiku 4.5, run B: **gains 6, losses 2** (gains > losses), both-confident 7 (feature-id agreement 7/7), both-none 10.
- Self-agreement A vs B (noise floor at medium): confident/none verdict equal on **16/25** (9 flips — far noisier than leg 1 low's 24/25); where verdicts agree, chosen feature id equal on **16/16**.
- Both medium runs clear the leg-1 RED bar (confident 16 and 13 vs 4.5's 9; paired gains > losses in both), but the 9-verdict run-to-run flip rate means per-defect stability is materially worse than at effort low — flag for the ship decision, not decided here.
- Cost caveat unchanged from leg 1: `usage.input_tokens` excludes cache reads (A's larger input count is the cache-warming run); both runs' est-usd=0.01, whole leg-2 verification stays far under the $0.10 budget.
- Output averaged ~117 tokens/call (thinking + answer) against the 2048 cap; no truncation (`stop=end_turn` on the probe, zero thrown errors in both runs).
- Leg-2 captures: `.ai-workspace/eval-captures/claude-haiku-5-5-2026-10-15T05-50-39-653Z.json` (A) and `...T05-53-02-298Z.json` (B) — gitignored, never printed; only aggregates above.

### Leg 2 environment notes

- Same dispatch-shell deviation as leg 1: eval/test commands run as `env -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY node --env-file=.env …` (harness exports `ANTHROPIC_MODEL=glm-5.3` and an empty key; `--env-file` never overrides pre-set names).
- The `.env` / `.ai-workspace/catalog` relative symlinks from leg 1 still in place (gitignored, nothing committed).
- AC-9 restart step is unchanged (see leg-1 environment notes): orchestrator runs `npm run redeploy` on the primary checkout post-merge and checks the `llm-model:` line in the INSTALLED plist's StandardOutPath. The bot was NOT restarted here.
