## Review
DISPATCH-NONCE:OR-NONCE-0c98783d6b84ebbe
Decision: PASS
verdict: PASS

Task #3136 — plan-review round 3 (fresh seat; plan not authored here; neither earlier
reviewer). Plan: `.ai-workspace/plans/2026-10-15-3136-monday-bot-haiku-55.md` at HEAD
c9bb35c on branch 3136-haiku-55 (`git fetch origin && git merge --ff-only
origin/3136-haiku-55`: already up to date). Rounds 1 and 2 were NEEDS-WORK; this
round's scope: every r1/r2 finding folded, the operator's 2026-10-15 noise-floor
decision carried, and new load-bearing defects only.

## Fold adjudication (re-verified by execution at c9bb35c)

| Prior finding | Round-3 check | Landed? |
|---|---|---|
| r1-1 BLOCKER — AC-3 unsatisfiable (4 residual `temperature:` lines) | `command grep -rn -E "temperature\s*:" src scripts` returns exactly 9 lines at HEAD; decision 4 names all 9 (5 request fields `generate.ts:526`, `nlFilterMapper.ts:263`, `feature-flow-eval.js:90`, `build-catalog.js:83`, `backfill-namespaced-labels.js:192`; the `MessagesCreate` type field `nlFilterMapper.ts:35`; doc comments `growthProposer.ts:5`, `featureFlowMatcher.ts:7,:58`). The non-matching accuracy-only mentions (`nlFilterMapper.ts:10`, `generate.ts:485,517` — no colon, verified) are correctly separated. | YES |
| r1-2 MEDIUM — AC-7 aggregates hide per-defect regressions | AC-7 requires per-defect capture in both arms (gitignored — `git check-ignore` confirms `.gitignore:9` covers any path under `.ai-workspace/`) and a paired gains/losses split; `losses > gains` is RED even when the aggregate inequality holds | YES |
| r1-3/4/5 LOW — build prereq; AC-9 resolved-id-only; dist-last-good scoping | AC-7/AC-8 chain `npm run build &&`; decision 6 + AC-9 both state resolved requested id, never `res.model`; risk row scoped to the primary checkout | YES |
| r2-1 BLOCKER — AC-2 x AC-4 mutual exclusion | AC-2's file-list grep is now `command grep -rln "claude-haiku-5-5" src scripts` -> exactly one path; AC-4's literal lives in `tests/generate.test.ts` (grep-verified absent there today, exit 1 — red by construction). The two greps no longer share a scope, so a state satisfying both exists. Decision 1 reworded to match (tests/ literal = assertion oracle + stub sentinel only). | YES |
| r2-2 LOW + operator decision 2026-10-15 — run the Haiku 5.5 arm TWICE (noise floor) | Executor note 2 is imperative ("run the Haiku 5.5 arm of AC-7 TWICE on the same fixed first-25 sample ... report per-defect self-agreement (confident/none AND chosen feature id equal) in the PR body next to the paired A/B split"); the cost section budgets the repeat (+~$0.007). Carried. Per the round-scope contract it stays an executor note, not an AC arm — see note 1 below for the execution-review hand-off. | YES |
| r2-3/4 LOW — over-named AC-3 scope; undated alias validity | Executor notes 3 and 4 carry both; no AC change needed | YES |

## Premises re-verified from primary sources (closed list 1a/1b/1c)

- **Model-id census (1a):** `command grep -rn "claude-haiku-4-5" src scripts tests` ->
  exactly the 5 named sites, all reading `ANTHROPIC_MODEL` first (?? or ||). Repo-wide
  census excluding node_modules/.git/dist*/.ai-workspace: the dated id
  `claude-haiku-4-5-20251001` appears at exactly those 5 lines and nowhere else;
  no other `claude-*` model literal outside `tests/__stubs__/anthropic-sdk.js:65`
  (`claude-haiku-stub` sentinel, which echoes `_req.model` first — verified). Price
  constants `scripts/feature-flow-eval.js:49-50` as the plan says. Premise exhaustive;
  one source of truth is achievable (check 4 clean).
- **Price (1b):** fetched platform.claude.com/docs/en/about-claude/pricing (HTTP 200,
  2026-10-15, after one transient curl retry). Standard table: "Claude Haiku 5.5 ...
  $0.10 / MTok for prompts up to 100,000 tokens $0.50 / MTok $0.125 / MTok $0.20 /
  MTok $0.01 / MTok $0.50 / MTok for prompts over 100,000 tokens $2.50 / MTok"; legacy
  table "Claude Haiku 4.5 $1 / MTok $5 / MTok"; long-context section "Claude Haiku 5.5
  is priced by prompt length". All match the plan's card. (The $0.05/$0.25 Haiku 5.5
  rows on the page are the 50%-off batch table, not standard — plan correctly cites
  the standard one.)
- **Request-shape claims (1c):** fetched
  platform.claude.com/docs/en/models/haiku-5-5/migration-guide (HTTP 200). "Remove
  sampling parameters ... On Claude Haiku 5.5, omit all three [temperature, top_p,
  top_k] ... If a request includes temperature, it must be 1"; adaptive thinking
  example `"thinking": {"type": "adaptive"}, "output_config": {"effort": "medium"}`;
  "Thinking tokens count toward max_tokens"; "select blocks by their type field";
  "the same text counts as more tokens ... A max_tokens limit tuned for Claude
  Haiku 4.5 may cut off equivalent output". Installed SDK 0.90.0
  (node_modules/@anthropic-ai/sdk/package.json): `messages.d.ts` types
  `OutputConfig.effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'` ('low' legal,
  no SDK bump), `temperature?: number` OPTIONAL (dropping it typechecks), and the
  `Model` union carries `(string & {})` so `claude-haiku-5-5` typechecks. Caps
  verified: mapper 512 (`nlFilterMapper.ts:29`), eval/backfill 256, generate 1024,
  build-catalog 4096 — the plan's "two scripts cap at 256, mapper at 512" is accurate.
- **Behaviour risk (check 2):** the A/B with the paired split measures the
  cross-model shift; the noise-floor repeat (executor note 2) measures the
  run-to-run variance of the 5.5 arm itself — the exact determinism cost of losing
  `temperature: 0`. n=25 is small for aggregate power, which is precisely why the
  paired split + self-agreement count (not just the inequality) are required
  captures; that is the stronger cheap check, and it is carried.
- **AC red states / smoke / restart (check 3):** AC-1 red (5 matches), AC-2 red
  (0 paths, exit 1), AC-3 red (9 matches) — all run at HEAD by me. AC-4's new
  assertions red by construction (the literal is absent from
  `tests/generate.test.ts` today; `req.temperature).toBe(0)` at :89 must flip).
  AC-5 proves the SERVED id via `res.model` with a `^model=claude-haiku-5-5` PREFIX
  match (getClient confirmed at `src/llm/anthropicClient.ts:77`). Restart: the plan
  scopes it to the ship tail via `npm run redeploy` (`package.json:11` ->
  `scripts/redeploy-local.sh`, which itself does the launchctl kickstart and prints
  "Freshness PROVEN: live build-stamp sha=... == HEAD ..."); the executor runs no
  launchctl. Plist template sets EnvironmentVariables = PATH + NODE_ENV only and
  StandardOutPath = monday-bot.out.log, as AC-9 assumes.
- **AC-7b premise:** `assertCatalogReviewed` required from `dist/catalog/reviewedGate`
  at `scripts/feature-flow-eval.js:38` — the reviewed gate exists as described.

## Findings (no blockers — every fold landed; no new load-bearing defect found)

1. **LOW (note) — the noise-floor repeat is checkable only in the PR body.** The
   operator's twice-run decision lives in executor note 2 + the cost line, not an AC
   arm — the right form under the round-scope contract (an enumerated AC arm is the
   next attack surface). Hand-off: execution-review must verify the PR body actually
   carries the 5.5-arm per-defect self-agreement line (confident/none AND chosen
   feature id equal across the two repeats) next to the paired A/B split — the
   captures themselves are gitignored and never printed.
2. **LOW (note) — AC-9's `$REDEPLOY_LOG_FILE` default needs the INSTALLED plist's
   path.** The committed template `deploy/launchd/com.monday-bot.plist.template`
   carries `<LOG_DIR>` placeholders; the ship-tail operator must resolve the real
   StandardOutPath from the installed plist (or the redeploy script's own log
   variable), not grep the template.
3. **LOW (note) — the migration guide also demands omitting `top_p`/`top_k`.** Both
   are absent from `src scripts` today (grep exit 1, verified), so nothing can
   regress — but AC-3's pattern only covers `temperature:`, so the executor must not
   "balance" the dropped field by adding any other sampling param while adding
   `output_config`.
4. **LOW (note) — `estimateCost`'s inline 4.5 numbers in
   `tests/triage.featureFlowEval.test.ts` stay by design** (pure-arithmetic fixture,
   model-agnostic); decision 3 correctly scopes the shared rate card to the module +
   eval `PRICING`. No second source of truth is created.

## Executor notes

1. Carried from r2 and still binding: AC-2's grep is scoped to `src scripts`; do not
   "fix" anything by moving the `claude-haiku-5-5` literal out of
   `tests/generate.test.ts` — that literal IS the AC-4 oracle.
2. When adding `output_config: { effort: "low" }`, add no sampling parameter of any
   kind (finding 3).
3. Ship tail (AC-9): resolve the log path from the installed plist, not the
   `<LOG_DIR>`-templated one (finding 2); the `llm-model:` line must print the
   resolved REQUESTED id, never `res.model` (cairn date-suffix lesson, carried).
4. PR body must carry, per AC-7 + executor note 2: both arms' counts lines, each
   arm's cost line on its own rate card, measured `usage` totals, the paired
   gains/losses split with feature-agreement count, AND the 5.5-arm self-agreement
   from the twice-run repeat.

## Held-out probes (run at HEAD c9bb35c, pre-change; "expected" = post-change pass state)

| variant | direction | expected | observed |
|---|---|---|---|
| `command grep -rn "20251001" .` (excl. node_modules/.git/dist*/.ai-workspace) | dated old id gone from every committed file (AC-1 + r2 note 4) | exit 1 | exit 0 — exactly the 5 named sites, nowhere else (red confirmed; census exhaustive) |
| `command grep -rln "claude-haiku-5-5" src scripts` | one source of truth (AC-2) | exactly 1 path (the new module) | 0 paths, exit 1 (red confirmed) |
| `command grep -rn -E "temperature\s*:" src scripts` | no sampling field anywhere (AC-3) | exit 1 | 9 matches; all 9 individually named in decision 4's scope — r1's blocker fix holds |
| `command grep -n "req.temperature).toBe(0)" tests/generate.test.ts` | #1195 pin flipped to `undefined` + new-id assert (AC-4) | exit 1 | 1 match at :89 (red by construction) |
| `command grep -rn "claude-haiku-stub" src scripts` | stub sentinel confined to tests/ | exit 1 | exit 1 (already clean; stays clean) |
| `command grep -rn -E "top_p\|top_k" src scripts` | migration guide: omit ALL sampling params | exit 1 | exit 1 (clean today — keep clean, finding 3) |
| `git check-ignore .ai-workspace/ac7-capture/probe.json` | AC-7 per-defect captures stay uncommitted | exit 0 | `.gitignore:9 .ai-workspace/` covers any such path |
| `command grep -c "ANTHROPIC_MODEL"` across the 5 call-site files | override preserved through the module (AC-2b) | >= 1 per site, resolution moves into the module | 5/5 files match (1/3/1/2/2), all env-first; scripts already `require` from `dist/` (`path.join(DIST, ...)` in all three), so consuming a `dist/llm/` module needs no new mechanism |
| `ANTHROPIC_MODEL=claude-haiku-4-5` live one-off (AC-6 shape) | override still wins post-change | `model=claude-haiku-4-5...` prefix | NOT RUN — live credentialed call; left to the executor's AC-6 (read-only seat) |

cairn: `( cd ../../../../ai-brain && node skills/cairn/bin/cairn-find.mjs "haiku" )` ->
[T1] 2026-10-08 run-scratch 4236cea4...jsonl:165 "When a result's model name can carry
a date suffix (for example a dated alias of ...)" — corroborates AC-5's prefix match and
decision 6's resolved-requested-id log line; also :1 "When switching a script or seat to
Haiku 5.5 ... first" matches the plan's request-shape-before-id-swap ordering, and :429
"When Haiku is called with a small max-output cap (such as 600), long replies are
[truncated]" corroborates the effort-low/cap risk row.
