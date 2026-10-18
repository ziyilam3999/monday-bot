## Review

#3136 execution-review, ROUND 4 (fresh seat; wrote neither the code nor rounds 1-3). PR ziyilam3999/monday-bot#267, branch 3136-haiku-55, reviewed at head 4324115 (code unchanged since ccc5e2c; 943c6ea and 4324115 only add the round-2 and round-3 review files).
Round 4 had one job: run the live generator probe on Haiku 5.5 on the API-key path (operator decision 2026-10-19), because rounds 2-3 got 9 straight 429s on the OAuth path.

Decision: PASS

Why PASS: the green bar is met. At the shipped cap of 8192, `stop_reason=end_turn` in 3/3 live runs on `claude-haiku-5-5`, with at most 819 output tokens used (about 10% of the cap). No code defect was found in rounds 2-4. Typecheck is green. Jest is green apart from the same one machine-local symlink failure rounds 2 and 3 saw, and that failure does not come from the diff. The PR merges cleanly.

Named-risk notes: `node hooks/named-risk-notes.mjs list --task 3136` printed `NO-NOTES 3136`. Nothing was carried, so there is nothing to disposition.

## Live probe (Haiku 5.5, real built generator, API-key auth)

Setup:
- `npm run build` rc 0, so `dist/` matches head (`dist/.build-stamp` sha=4324115). `dist/llm/generate.js:20` reads `const MAX_TOKENS = 8192;`.
- The probe script was re-created under the session scratchpad with the same behaviour as round 2's. It calls the real built `generateAnswer` with 5 synthetic chunks and one 3-part how-to question (book a space, cancel 2 days ahead, host payout). It wraps `messages.create` to force `max_tokens` to the cap and records `stop_reason`, output tokens, content block types and the request id for every call.
- Auth: the probe loads the bot env file with Node's built-in env-file loader. That is the same mechanism the repo's scripts document (`node --env-file=.env`). It builds the SDK client with ONLY `apiKey` from `process.env.ANTHROPIC_API_KEY`, never with `authToken`, and swaps it in for the bot's `getClient()`. The probe process ran under `env -u ANTHROPIC_MODEL -u MONDAY_TEST_MODE -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN`, and the probe also deleted those four keys after loading the env file. The env file sets neither `ANTHROPIC_MODEL` nor `MONDAY_TEST_MODE` (the probe printed booleans only). Probe output: `auth=apiKey`. No credential or env file was opened or printed by the reviewer.
- Resolved model: `claude-haiku-5-5`, the default and not an override. The request model and the response model both read `claude-haiku-5-5`.

| cap | run | stop_reason | output tokens | input tokens | blocks | request id |
|---|---|---|---|---|---|---|
| 8192 | 1 | end_turn | 768 | 3064 | thinking,text | req_011Cg9zGynnA2hmw7kZw9H23 |
| 8192 | 2 | end_turn | 819 | 3064 | thinking,text | req_011Cg9zHHUuM9s7B34oDFsi4 |
| 8192 | 3 | end_turn | 780 | 3064 | thinking,text | req_011Cg9zHatQWJMMVE5mtidC4 |
| 1024 | 1 | end_turn | 727 | 3064 | thinking,text | req_011Cg9zJKCcLZTE6FJbFefFS |
| 1024 | 2 | end_turn | 721 | 3064 | thinking,text | req_011Cg9zJcVRGmFYZXtLwe1ys |
| 1024 | 3 | end_turn | 771 | 3064 | thinking,text | req_011Cg9zJtgWduR386Z76KWuP |

Each run made exactly one model call: the backstop retry did not fire. Every answer was non-empty (1151-1312 chars) with 2-3 citations. There were no 429s and no retries. Total live spend was about 12 output kTok + 18 input kTok, under $0.01 at the Haiku 5.5 card.

## Findings

1. **INFO (green bar MET): cap 8192 -> end_turn 3/3** on the API-key path, with a peak of 819 output tokens (thinking + text). That leaves about 10x headroom, which is what fix 1 promised.
2. **LOW (observation, non-blocking): this probe question did not reproduce the 1024 truncation.** At cap 1024 all 3 runs also ended `end_turn` (721-771 tokens). Round 1's probe saw 2/3 `max_tokens` stops at 1024 with a different question and run. The default thinking budget varies by prompt. So this probe shows that 8192 is safe. It does not show that 1024 is always unsafe. The 8192 cap still costs at most about $0.004 per reply, and its failure mode (a cut-off reply) is worse than the cost, so the cap stays justified.
3. **INFO: regression at head.**
   - `npm run typecheck`: rc 0.
   - `env -u ANTHROPIC_MODEL npx jest`: `Test Suites: 1 failed, 60 passed, 61 total`, `Tests: 1 failed, 608 passed, 609 total`.
   - The one failure is `tests/catalog.test.ts` AC-GITIGNORED (`fatal: pathspec '.ai-workspace/catalog/feature-catalog.json' is beyond a symbolic link`). It is the same machine-local cause rounds 2 and 3 recorded: `.ai-workspace/catalog` in this worktree is a local, gitignored symlink. `git diff origin/master...HEAD -- tests/catalog.test.ts .gitignore` is empty, so the diff does not touch the test or the ignore rule. Round 3 showed 609/609 passing with the symlink moved aside. This round did not move it, to avoid changing the worktree.
4. **INFO: merge state.** `gh pr view 267`: `mergeStateStatus: CLEAN`, `mergeable: MERGEABLE`, head `4324115`, base `master`, draft, open.
5. **Carried from round 2, unchanged, non-blocking (follow-up candidates):**
   - MEDIUM: a `max_tokens` stop is only warned in the console, and the Slack user still sees the cut-off text.
   - LOW: a whitespace-only `ANTHROPIC_MODEL` passes through.
   - LOW: a truncated backstop retry replaces a complete first answer.

Monotonicity: no code changed since round 2, so round 2's checklist stands. `resolveModel`: a set value beats empty or unset. `warnMaxTokensStop`: observer only. Backstop `text = retry`: predates this PR.

cairn: `node skills/cairn/bin/cairn-find.mjs "apiKey"` -> [WM] 2026-05-11 pre-compact card: "Hidden SDK retry layer. `anthropic.ts:198,208` constructs `new Anthropic(`..." (the SDK's built-in retry). It is relevant because no 429 or retry occurred in this round. Rounds 2-3 cited `rate_limit` and `max_tokens` lessons, and those were cleared here.
