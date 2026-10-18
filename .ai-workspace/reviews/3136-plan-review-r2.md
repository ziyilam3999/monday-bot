## Review
DISPATCH-NONCE:OR-NONCE-30cd9bb77683aeef
Decision: NEEDS-WORK
verdict: NEEDS-WORK

Task #3136 — plan-review round 2 (fresh seat; plan not authored here; not the round-1
reviewer). Plan: `.ai-workspace/plans/2026-10-15-3136-monday-bot-haiku-55.md` at HEAD
b54949d on branch 3136-haiku-55 (fetch + `git merge --ff-only origin/3136-haiku-55`:
already up to date). Round-1 verdict NEEDS-WORK (1 BLOCKER + 1 MEDIUM + LOWs); this
round's scope: every r1 finding folded, plus new load-bearing defects only.

## r1 fold adjudication (all re-verified by execution at b54949d)

| r1 finding | Fold claim | Round-2 check | Landed? |
|---|---|---|---|
| 1 BLOCKER — AC-3 unsatisfiable (4 residual lines) | decision 4 names every match | `command grep -rn -E "temperature\s*:" src scripts` returns exactly 9 lines at HEAD; all 9 are named in decision 4's scope (5 request fields `generate.ts:526`, `nlFilterMapper.ts:263`, `feature-flow-eval.js:90`, `build-catalog.js:83`, `backfill-namespaced-labels.js:192`; the `MessagesCreate` type field `nlFilterMapper.ts:35`; doc comments `growthProposer.ts:5`, `featureFlowMatcher.ts:7,:58`). The plan's "13 mentions, 9 matching" census is exactly what I count. | YES |
| 2 MEDIUM — AC-7 aggregates hide per-defect regressions | paired gains/losses split | AC-7 now requires per-defect capture in both arms (gitignored path — `.gitignore:9` covers `.ai-workspace/`, verified) and `losses > gains` is RED even when the aggregate inequality holds | YES |
| 3 LOW — AC-7/AC-8 missing build prereq | chain `npm run build &&` | both ACs now chain it; verified live: `npm run build && node scripts/feature-flow-eval.js` exits 0, `total=3 ... confident=2 none=1` + the "ZERO model calls" line | YES |
| 4 LOW — AC-9 anchored grep only safe for resolved id | decision 6 + AC-9 wording | both state the `llm-model:` line prints the resolved requested id, never `res.model` | YES |
| 5 LOW — dist-last-good absent in worktree | risk row scoped | risk row now says "Applies to the PRIMARY checkout only" | YES |
| Executor notes 1-5 | mapped in fold table | note 1 -> decision 4 (type field + comments named); 2 -> AC-7/8 build chains; 3 -> AC-7 paired capture; 4 -> decision 6; 5 -> decision 8 + `--env-file=.env` kept in AC-5/6/7 | YES |

## Premises re-verified from primary sources (closed list items 1a/1b/1c)

- **Model-id census (1a):** `command grep -rn "claude-haiku-4-5" src scripts tests` ->
  exactly the 5 named sites, each reading `ANTHROPIC_MODEL` first. Repo-wide census
  (`src scripts tests deploy docs README.md CHANGELOG.md package.json`) finds no other
  `claude-*` model literal except the stub sentinel `claude-haiku-stub`
  (`tests/__stubs__/anthropic-sdk.js:65`). Price constants:
  `scripts/feature-flow-eval.js:49-50` `PRICING = {1.0, 5.0}` labelled Haiku 4.5, as
  the plan says. Premise exhaustive — decision 1's one-source-of-truth is achievable
  and AC-1/AC-2 enforce it (check 4 clean, modulo finding 1 below).
- **Price (1b):** fetched platform.claude.com/docs/en/about-claude/pricing (HTTP 200,
  2026-10-15). Standard-table row, tags stripped: "Claude Haiku 5.5 ... $0.10 / MTok
  for prompts up to 100,000 tokens $0.50 / MTok $0.125 / MTok $0.20 / MTok $0.01 /
  MTok $0.50 / MTok for prompts over 100,000 tokens $2.50 / MTok" — input/output/
  5m-write/1h-write/hit/long-context exactly as the plan cites. Long-context section:
  "Claude Haiku 5.5 is priced by prompt length: a request whose prompt is over 100,000
  tokens pays higher prices." Matches.
- **Request-shape claims (1c):** fetched
  platform.claude.com/docs/en/models/haiku-5-5/migration-guide (HTTP 200). "Remove
  sampling parameters" section: "If a request includes temperature, it must be 1. ...
  Any other temperature or top_p value returns a 400 error" — dropping the field is
  the documented remedy. Thinking section: after-example is exactly
  `"thinking": {"type": "adaptive"}, "output_config": {"effort": "medium"}`; "Adaptive
  thinking is on by default"; "Thinking tokens count toward max_tokens, so a request
  with a small max_tokens can stop with stop_reason: 'max_tokens' after a thinking
  block and before any text"; "Select content blocks by their type field rather than
  by position". Installed SDK: `@anthropic-ai/sdk` 0.90.0
  (`node_modules/@anthropic-ai/sdk/package.json`), and
  `resources/messages/messages.d.ts` types `OutputConfig { effort?: 'low' | 'medium'
  | 'high' | 'xhigh' | 'max' }` — `'low'` legal, no SDK bump needed. The Model union
  does not list `claude-haiku-5-5` but includes `(string & {})`, so the new id typechecks.
- **Behaviour risk (check 2):** the A/B (with the folded paired split) measures the
  cross-MODEL quality shift on a fixed sample, which is the right shape for "5.5 at
  least as good as 4.5". It does not measure the run-to-run variance introduced by
  dropping `temperature: 0` itself — see finding 2 (LOW) for a stronger cheap check.
- **AC red states / smoke / restart (check 3):** AC-1 red (5 matches), AC-2 red
  (0 paths for `claude-haiku-5-5`), AC-3 red (9 matches) — all run at HEAD. AC-4:
  `npm run typecheck && npm test` both exit 0 at HEAD (60/60 suites, 600/600 tests);
  the NEW assertions (`req.temperature === undefined`, `req.model` = new id) are red
  by construction until implemented. AC-5 proves the served id via `res.model` with
  prefix match (`getClient` confirmed at `src/llm/anthropicClient.ts:77`). Restart:
  `package.json:11` `redeploy` -> `scripts/redeploy-local.sh`, whose line 106 prints
  "Freshness PROVEN: live build-stamp sha=... == HEAD"; plist template sets
  EnvironmentVariables + StandardOutPath as AC-9 assumes. The restart is correctly
  owned by the ship tail (no executor launchctl).

## Findings

1. **BLOCKER — AC-2 and AC-4 are mutually unsatisfiable as written (new load-bearing
   defect; both clauses predate the fold — r1 did not catch the interaction).** AC-4's
   checkable form requires `command grep tests/generate.test.ts` for `claude-haiku-5-5`
   to hit >= 1 — i.e. the literal must appear in `tests/generate.test.ts` (it is absent
   today: grep exits 1, verified). But AC-2's first clause is
   `command grep -rln "claude-haiku-5-5" src scripts tests` with pass condition
   "exactly ONE path printed (the model module)". Any state that satisfies AC-4's
   clause makes that grep print TWO paths (the module AND `tests/generate.test.ts`),
   failing AC-2; any state that satisfies AC-2's count leaves AC-4's grep clause at
   zero hits. The executor cannot pass both, and execution-review greps will flag one
   of them — a guaranteed re-fold. Decision 1 ("No literal model id remains anywhere
   else in `src/`, `scripts/` or `tests/` except that module and the stub sentinel")
   sides with AC-2, so the consistent fix is one line: scope AC-2's file-list grep to
   `src scripts` (drop `tests` — the stub sentinel already makes tests/ a special
   case), or alternatively rewrite AC-4's parenthetical to grep the test for the
   assertion form that imports the module's exported default instead of embedding the
   literal. This is the only change required before execution.

2. **LOW — the A/B does not measure the determinism cost of dropping `temperature: 0`
   (behaviour risk, check 2).** The paired gains/losses split (fold 2) detects
   cross-model regressions, but sampling noise WITHIN the 5.5 arm is invisible: two
   runs of the same arm could disagree per-defect and no AC would show it. Stronger
   cheap check (~$0.007 at the cited rate card, zero new code — decision 7's fixed
   sample makes it a repeat): run the Haiku 5.5 arm TWICE on the same first-25 sample
   and report per-defect self-agreement (confident/none + chosen feature id equal
   across repeats) in the PR body; the disagreement count is the noise floor directly
   attributable to the lost sampling pin. Not a blocker under the round-2 scope
   (addition, not a refuted premise); recommend as an executor note.

3. **LOW (note) — decision 4 slightly over-names AC-3 scope.** `generate.ts:485,517`
   and `nlFilterMapper.ts:10` contain "temperature" but do NOT match the AC-3 pattern
   `temperature\s*:` (verified: they say "temperature 0" / "raised temperature"
   without a colon), so rewording them is required for accuracy only, not for AC-3 to
   exit 1. Harmless over-inclusion; recorded so the executor does not hunt for a grep
   match that is not there. The plan's own counts (9 matching, 13 total) are correct.

4. **LOW (note) — AC-6's override value `claude-haiku-4-5` (undated alias) is a valid
   model id** in the SDK's Model union, and AC-6's prefix expectation covers whatever
   dated form the API echoes. No change needed; noted so nobody "fixes" it to the
   dated id inside a committed file (AC-1 greps files, not env vars — the dated id
   lives only in the AC-7 shell env, which is correct).

## Executor notes

1. Land finding 1's one-line plan fix BEFORE implementation (recommend: AC-2 first
   clause becomes `command grep -rln "claude-haiku-5-5" src scripts` -> exactly one
   path; keep the `ANTHROPIC_MODEL` sub-check unchanged).
2. Optional per finding 2: repeat the 5.5 arm on the same fixed sample and report
   per-defect self-agreement alongside the paired A/B split.
3. `generate.ts:485,517` and `nlFilterMapper.ts:10` rewording is for accuracy only —
   they cannot affect AC-3's grep (finding 3).
4. Keep the dated old id out of committed files; it appears only in AC-7's env
   override (finding 4).

## Held-out probes (run at HEAD b54949d, pre-change; "expected" = post-change pass state)

| variant | direction | expected | observed |
|---|---|---|---|
| `command grep -rn "output_config" src scripts` | effort field added on short routes (decision 5) | >= 3 matches (mapper, eval, backfill) | exit 1 — 0 matches (red confirmed) |
| `command grep -rn "llm-model" src scripts` | startup log line added (decision 6) | >= 1 match | exit 1 — 0 matches (red confirmed) |
| `command grep -rln "claude-haiku-5-5" src scripts tests` in any state satisfying AC-4's grep clause (literal present in `tests/generate.test.ts`) | single source of truth (AC-2) | exactly 1 path | 2 paths — module + `tests/generate.test.ts` (finding 1, the blocker) |
| `command grep -rn "claude-haiku" CHANGELOG.md README.md docs deploy package.json` | old id confined to the 5 named sites (check 4) | exit 1 | exit 1 — no model literal outside src/scripts/tests (clean today; AC-1 keeps it so) |
| `command grep -rn "ANTHROPIC_MODEL" src scripts` | override preserved through the module (AC-2b) | module resolves env-first for all consumers | 5 matches, one per call site, all env-first (as the plan's table says) |
| `npm run typecheck && npm test` at HEAD | green baseline, so AC-4's red state is carried only by the new assertions | both exit 0 post-change | both exit 0 now (typecheck clean; 60/60 suites, 600/600 tests) |
| `npm run build && node scripts/feature-flow-eval.js` | AC-8 synthetic mode unchanged (fold 3) | exit 0 + "ZERO model calls" | exit 0, `total=3 ... confident=2 none=1` + "ZERO model calls, ZERO cost" line |
| `command grep -n "ai-workspace" .gitignore` | AC-7's per-defect captures stay uncommitted | covered | `.gitignore:9` -> `.ai-workspace/` covered |

cairn: `( cd ../../../../ai-brain && node skills/cairn/bin/cairn-find.mjs "haiku" )` ->
[T1] 2026-10-08 run-scratch 4236cea4:165 "When a result's model name can carry a date
suffix (for example a dated alias of ...)" — corroborates decision 6/AC-9's
resolved-requested-id + prefix-match design; also :429 "When Haiku is called with a
small max-output cap (such as 600), long replies are [truncated]" corroborates the
effort-low/cap risk row, and :1 "When switching a script or seat to Haiku 5.5 ...
first" matches the plan's request-shape-first ordering.
