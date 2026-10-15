## Review

# #3136 execution-review — monday-bot default model Haiku 4.5 -> Haiku 5.5

Seat: execution-review (fresh, stateless; wrote none of the diff). PR ziyilam3999/monday-bot#267, branch `3136-haiku-55`, reviewed at HEAD `2e9f830` (fast-forward confirmed; merge-base = origin/master `e4e7585`).
Plan: `.ai-workspace/plans/2026-10-15-3136-monday-bot-haiku-55.md`. Executor close: `.ai-workspace/reviews/3136-executor-close.md`.
No dispatch nonce was printed in this seat's instructions.
Out of scope by operator decision (2026-10-15, authenticated): classifier effort `medium` and its measured run-to-run flip rate. Not re-litigated below.

verdict: NEEDS-WORK

## Findings

1. **HIGH (blocking) — the Slack answer generator now truncates real answers silently.** `src/llm/generate.ts` keeps `MAX_TOKENS = 1024` and sends no effort, so Haiku 5.5 runs its default `medium` adaptive thinking, and thinking counts toward `max_tokens` (bundled claude-api skill, `shared/model-migration.md` -> Migrating to Claude Haiku 5.5 -> "Thinking counts toward `max_tokens`"). `callModel` never reads `stop_reason`; it joins whatever text came back and `generateAnswer` posts it as a finished answer. Measured with a probe that sends the generator's exact request shape (the built `SYSTEM_PROMPT`, the generator's `Question/Context/Answer...` user layout, 5 short synthetic chunks, one 3-part how-to question, max_tokens 1024, no effort):
   - Haiku 5.5, 3 runs: `stop=max_tokens out_tokens=1024 text_chars=1186`, `stop=max_tokens out_tokens=1024 text_chars=800`, `stop=end_turn out_tokens=741 text_chars=1624`. So 2 of 3 answers were cut off mid-text, and every response opened with a thinking block.
   - Control, same probe with `ANTHROPIC_MODEL=claude-haiku-4-5`, 2 runs: `stop=end_turn` at 261 and 279 output tokens.
   This is a regression the diff introduces on the bot's main user-facing path. No AC covers it: AC-5 probes a one-word "OK", and AC-7 exercises only the classifier. Plan decision 5 and risk 2 rely on "the smoke/eval ACs catch truncation (`stop_reason: max_tokens`) if it still occurs", and for this route they cannot. Remedy, inside the plan's own risk-2 clause ("raise its cap — a one-line change inside the same PR"): raise the generator cap well above 1024 (the skill's non-streaming default is about 16000; 4096 is a floor worth measuring), AND surface `stop_reason === "max_tokens"` in `callModel` (at least a `console.warn` counter) so a truncated answer is never posted silently. Then re-run a real-size generator probe and record `stop=end_turn`. A thinking-ONLY truncation is already loud-ish: empty text falls through to `NO_CONTEXT_ANSWER` with a warn.
2. **LOW — classifier routes ignore `stop_reason`, but no truncated reply is parsed as an answer.** Held-out (offline, built `dist/`): a thinking-only or mid-JSON reply makes `matchFeatureFlow` THROW ("no JSON object"), which is loud in the eval and backfill. `nlFilterMapper` degrades to the empty filter plus the deterministic floor, its documented degrade path from before this diff, but logs nothing. Measured headroom at the 2048 cap: about 117 output tokens/call in the executor's runs and about 251/call in this seat's eval re-run (6,289 / 25). Note, not a blocker. A `stop_reason` warn in the mapper would make a future truncation visible.
3. **LOW — `scripts/build-catalog.js` (4096 cap, default `medium`, large JSON output) is unmeasured on Haiku 5.5.** A truncated catalog reply would throw "no JSON object", so it fails loudly, not silently. It is an operator-run script. Worth a probe before the next catalog rebuild.
4. **LOW — empty `ANTHROPIC_MODEL` changes behaviour in the scripts.** The three scripts used `process.env.ANTHROPIC_MODEL || default` and now use `resolveModel()` (`??`). Held-out: `ANTHROPIC_MODEL=""` resolves to `""`, so the scripts would send an empty model id (API 400) where they used to fall back to the default. `src/` already used `??` before this diff. Low reach, since the brief records 0 `ANTHROPIC_MODEL` keys in `.env`.
5. **LOW — an unknown model id passes through unvalidated and is priced on the 5.5 card.** `ANTHROPIC_MODEL=claude-haiku-9-9` gives `resolveModel="claude-haiku-9-9"` and pricing 0.1/0.5. The API would reject the call. Only the eval's cost line could mislead. Acceptable for an escape hatch.
6. **LOW — `npm test` is environment-sensitive in two ways, and neither is a code defect.** (a) In this worktree `npm test` exits 1: `tests/catalog.test.ts` AC-GITIGNORED fails with "pathspec ... is beyond a symbolic link". The cause is the executor's local, gitignored, uncommitted `.ai-workspace/catalog` symlink (from the close file's environment notes). With the symlink moved aside, the same suite exits 0 with 600/600, and it was restored afterwards. The executor's cleanup note already removes it with the worktree. (b) The rewritten #1195 test asserts `req.model === "claude-haiku-5-5"`, so it fails whenever `ANTHROPIC_MODEL` is exported in the test shell. That is expected under the override contract, but CI must not export it.
7. **INFO — model module, sampling and effort wiring are correct.** `src/llm/modelConfig.ts` is the only file under `src scripts` naming `claude-haiku-5-5`. `CLASSIFIER_EFFORT` is defined once and read by all 3 classifier sites (mapper, eval wrapper, backfill wrapper). No `temperature`/`top_p`/`top_k` field is sent anywhere. No call site reads content blocks by position: generate.ts, nlFilterMapper `extractText`, and the 3 script wrappers all filter on `type === "text"`. So **no call site can throw on a thinking block that appears before the text block**, and a held-out thinking-then-text reply parses correctly in both the matcher and the mapper. Remaining `temperature` mentions are a doc string in `scripts/eval-golden.js:124` (no colon, plan-allowed) and the test's `toBeUndefined()` assertion.
8. **INFO — eval honesty: reproduced.** The paired split was recomputed from the gitignored captures by a counts-only script: 4.5 vs 5.5 run A gives gains 8 / losses 1 / both-confident 8 (feature agreement 8) / both-none 8 = 25. 4.5 vs run B gives 6 / 2 / 7 (7) / 10 = 25. Self-agreement A vs B is 16/25 (9 flips). The leg-1 row also sums (2+5+4+14 = 25). The executor's numbers match exactly. This seat's own single re-run (same 25 keys, missing=0) gave `total=25 confident=16 none=9`, rc 0, zero thrown errors, est-usd 0.01, measured 87,850 in / 6,289 out. Against the 4.5 capture: gains 8, losses 1, both-confident 8, both-none 8 (sum 25). Against run A: 6 flips. Under AC-7's bar it is GREEN on the medium-effort arm.

Monotonicity checklist: one precedence arm, `resolveModel()` (env override vs default). The explicit env value is the stronger claim, and the default (`??`) cannot erase it. `pricingForModel` is a pure prefix branch, with no erase path. No clear-list or last-writer-wins arms are in the diff.

Named-risk notes: `node hooks/named-risk-notes.mjs list --task 3136` printed `NO-NOTES 3136`, so no dispositions are owed.

## AC table (re-measured by this seat at 2e9f830)

| # | Command | rc | Result |
|---|---|---|---|
| AC-1 | `command grep -rn "claude-haiku-4-5" src scripts tests` | 1 | PASS — zero matches |
| AC-2 | `command grep -rln "claude-haiku-5-5" src scripts` | 0 | PASS — one path, `src/llm/modelConfig.ts`; `ANTHROPIC_MODEL` count there = 4 |
| AC-3 | `command grep -rn -E "temperature\s*:" src scripts` | 1 | PASS — zero matches; `top_p\|top_k` also rc 1 |
| AC-4 | `npm run typecheck` / `env -u ANTHROPIC_MODEL npm test` | 0 / 1 | typecheck PASS. Suite: 599/600, with 1 failure = finding 6(a), caused by the local symlink. Re-run with the symlink moved aside: rc 0, 60/60 suites, 600/600 tests. `claude-haiku-5-5` in tests/generate.test.ts = 1. PASS on the code |
| AC-5 | live probe, default model, max_tokens 64, "reply with the single word OK" | 0 | PASS — `model=claude-haiku-5-5 stop=end_turn text_blocks=1` |
| AC-6 | same probe, `ANTHROPIC_MODEL=claude-haiku-4-5` | 0 | PASS — `model=claude-haiku-4-5-20251001 stop=end_turn text_blocks=1` (prefix match) |
| AC-7 | `npm run build` then `env -u ANTHROPIC_MODEL -u ANTHROPIC_API_KEY node --env-file=.env scripts/feature-flow-eval.js --real --limit 25` (one re-run) | 0 | PASS (medium arm) — 16/9; paired vs 4.5: gains 8 > losses 1 |
| AC-7b | n/a — main path ran | — | n/a |
| AC-8 | `npm run build && node scripts/feature-flow-eval.js` | 0 / 0 | PASS — "ZERO model calls" present (count 1) |
| AC-9 | post-merge, orchestrator | — | close file states the exact step: on the PRIMARY checkout run `npm run redeploy`, count `^llm-model: claude-haiku-5-5` in the INSTALLED plist's StandardOutPath, and confirm "Freshness PROVEN" sha = merged HEAD. `src/index.ts` prints `llm-model: ${resolveModel()}` (the requested id, never `res.model`) |
| AC-10 | privacy scan over every changed file + this review | 0 | CLEAN (see the Privacy section) |
| NEW (this seat) | generator-shape probe, max_tokens 1024, Haiku 5.5 x3 vs Haiku 4.5 x2 | 0 | **FAIL** — 2/3 `stop=max_tokens` on 5.5; 4.5 `end_turn` at about 270 tokens (finding 1) |

Suite logs: `tmp/suite-logs/er-typecheck.log`, `er-npm-test.log`, `er-npm-test-nosymlink.log`, `er-catalog-nosymlink.log`, `er-build.log`, `er-ac8.log`, `er-eval-rerun.log` (worktree-local, gitignored).

## Held-out table (this seat's own shapes)

| variant | direction | expected | observed |
|---|---|---|---|
| matcher gets a reply with ONLY a thinking block (empty text) | negative | not parsed as an answer; loud | THREW "no JSON object" |
| matcher gets a reply cut at max_tokens mid-JSON | negative | not parsed as an answer; loud | THREW "no JSON object" |
| mapper gets a thinking-only reply | negative | degrade, never a fabricated filter | empty filter (0/0/0); silent (finding 2) |
| generator real-size answer at max_tokens 1024 on Haiku 5.5 | negative | `end_turn`, full answer | **2/3 `stop=max_tokens`, partial text returned as an answer** (finding 1) |
| `ANTHROPIC_MODEL=""` (empty) | negative | fall back to default, as the scripts did before | resolves to `""` (finding 4) |
| `ANTHROPIC_MODEL=claude-haiku-9-9` (unknown id) | negative | passes through; API rejects it | passes through, priced 0.1/0.5 (finding 5) |
| matcher gets a thinking block BEFORE valid JSON text | positive | parsed by block type | feature=feature-alpha, flows=1 |
| mapper gets a thinking block BEFORE valid JSON text | positive | parsed; request carries no temperature, effort=medium, max_tokens=2048 | features=1 flows=1; `temperature=undefined effort=medium max_tokens=2048` |
| `ANTHROPIC_MODEL` unset | positive | `claude-haiku-5-5`, 5.5 card | `claude-haiku-5-5`, 0.1/0.5 |
| `ANTHROPIC_MODEL=claude-haiku-4-5` | positive | override wins, legacy card | `claude-haiku-4-5`, 1/5; live probe `stop=end_turn` |

## Privacy

`privacy-scan.sh --working <path>`, run once per file over all 16 files the branch changes (11 code/test files, plus the plan, close and 3 plan-reviews) and this review: 17/17 rc 0, `privacy-scan: CLEAN mode=working`. Positive control: a sandbox fixture carrying one home-path form gave rc 1, `privacy-scan: DIRTY (home-path matches=1, ...)`. Home-folder basename count (plain, dash-encoded, underscore forms) over the same 17 files: 0. The same grep on the control fixture counted 1.

cairn: `node skills/cairn/bin/cairn-find.mjs "haiku"` -> T2 2026-10-08-385167404: "When a Haiku call's output cap is small (600 tokens), replies get trunc..." — the same failure class as finding 1, now caused by default-on thinking eating a 1024 cap on the generator route.
