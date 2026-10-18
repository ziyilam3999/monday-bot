## Review

#3136 execution-review, ROUND 3 (fresh seat; wrote neither the code nor rounds 1-2). PR ziyilam3999/monday-bot#267, branch 3136-haiku-55, reviewed at head 943c6ea (code unchanged since ccc5e2c; 943c6ea only adds the round-2 review file).
Round 3 had one job: run the live generator probe on Haiku 5.5 that round 2 could not measure.

Decision: NEEDS-WORK

Why NEEDS-WORK: the green bar (`stop_reason=end_turn` in 3/3 runs at cap 8192) is still NOT MEASURED. Every live call returned HTTP 429 `rate_limit_error`: 4 attempts at cap 8192 (1 first try + 3 retries, 60s apart, as the brief allows) and 1 attempt at cap 1024. No code defect was found. Typecheck and jest are green, and the PR merges cleanly. The only thing left is the live measurement.

Named-risk notes: `node hooks/named-risk-notes.mjs list --task 3136` printed `NO-NOTES 3136`. Nothing was carried, so there is nothing to disposition.

## Live probe (Haiku 5.5, real built generator)

Setup: `npm run build` (rc 0) so `dist/` matches head; `dist/llm/generate.js:20` reads `const MAX_TOKENS = 8192;`. The probe script was re-created in the session scratchpad with the same behaviour as round 2's: it calls the real built `generateAnswer` through the bot's own `getClient()`, forces `max_tokens` to the cap, and records `stop_reason` and output tokens per call. It uses 5 synthetic chunks and one 3-part how-to question. Run as `env -u ANTHROPIC_MODEL -u MONDAY_TEST_MODE node <scratch>/probe.js <worktree>/dist <cap> 3`. No credential or env file was opened or printed.

| arm | attempt | run 1 stop / tokens | run 2 stop / tokens | run 3 stop / tokens | result | request id |
|---|---|---|---|---|---|---|
| cap 8192 | first try | - | - | - | 429 rate_limit_error | req_011Cg9xt6iFGKTPrb54Td7o8 |
| cap 8192 | retry 1 (+60s) | - | - | - | 429 rate_limit_error | req_011Cg9xyVMfQnsrxWKELkbPo |
| cap 8192 | retry 2 (+60s) | - | - | - | 429 rate_limit_error | req_011Cg9y4hPqtscQ7fPdBth1c |
| cap 8192 | retry 3 (+60s) | - | - | - | 429 rate_limit_error | req_011Cg9y9Sy4mrSSMMHcPSuKt |
| cap 1024 | single try | - | - | - | 429 rate_limit_error | req_011Cg9yAFyoSub4ZvhZ7wkxd |

Each attempt failed on the first request, so no tokens were produced and live spend was $0. Per the brief, no further retries were made.

## Findings

1. **NEEDS-WORK (blocking, process, not a code defect): live probe at cap 8192 NOT MEASURED. All 5 attempts got HTTP 429 (request ids above).** Rounds 2 and 3 together hit 9 straight 429s across two sessions. That points to a quota or rate-limit state on the bot's OAuth client, not to a short burst. Remedy: re-run the same probe when the limit has reset (or after the operator confirms the quota). The green bar is `end_turn` in 3/3 runs at 8192. This review has no way to clear the limit.
2. **INFO: regression at head is green.**
   - `npm run typecheck`: rc 0.
   - `env -u ANTHROPIC_MODEL npm test`: `Test Suites: 61 passed, 61 total`, `Tests: 609 passed, 609 total` (rc 0). This matches round 2's 609.
   - The first jest run showed 1 failure: `tests/catalog.test.ts` AC-GITIGNORED, `fatal: pathspec ... is beyond a symbolic link`. The cause is the worktree's local, gitignored `.ai-workspace/catalog` symlink, which is a property of this machine and not part of the diff. Round 2 saw the same thing. For the second run the symlink was moved aside, then moved back to the same target (verified with `readlink`).
3. **INFO: merge state.** `gh pr view 267`: `mergeStateStatus: CLEAN`, `mergeable: MERGEABLE`, head `943c6ea`, base `master`, draft, open.
4. **Carried from round 2, unchanged, non-blocking:** MEDIUM: a `max_tokens` stop is only warned in the console, and the Slack user still sees the cut-off text (follow-up ticket suggested). LOW: a whitespace-only `ANTHROPIC_MODEL` passes through. LOW: a truncated backstop retry replaces a complete first answer. None of these was re-opened, because the code did not change.

Monotonicity: no code changed since round 2, so round 2's checklist stands (`resolveModel`: a set value beats empty/unset; `warnMaxTokensStop`: observer only; backstop `text = retry`: predates this PR).

cairn: `node skills/cairn/bin/cairn-find.mjs --task 3136 "rate_limit"` -> [T2] 2026-09-28 lesson: "When retrying failed subagent/API calls, only retry on transient signal..." Retries were bounded to 3 at 60s, and the 429 persisted, so it is treated as not transient. `node skills/cairn/bin/cairn-find.mjs "max_tokens"` -> [T2] 2026-10-08 lesson: "When a trial or eval caps model output tokens (e.g. max_tokens 600) but asks for..." This is the same cap-truncation class the probe is meant to clear.
