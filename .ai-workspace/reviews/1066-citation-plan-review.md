# Plan Review — #1066 Citation / Answer Hygiene (slice 1)

Decision: PASS

Reviewer: stateless plan-review subagent. Scope: review only — no source/test files modified.
Plan reviewed: `.ai-workspace/plans/2026-06-23-1066-citation-answer-hygiene.md`.

> NOTE (filename collision): this file previously held the plan-review for the SEPARATE,
> already-merged rename slice (`2026-06-23-1066-rename-reserved-slash-commands.md`, PR #205).
> Both slices share task number 1066. That prior content remains in git history (commit
> abfa99a / PR #205) and is recoverable; this write replaces the working-tree copy with the
> citation-hygiene slice's review per the review brief's explicit path.

cairn: ran `node skills/cairn/bin/cairn-find.mjs "citation"` and `"slack format"` — no monday-bot-specific hits (matches were memory-magnitude lessons + generic git/tool-failure notes, none applicable). Nearest applicable discipline is the both-ends-testable / "eyeball the specific instance" parent-CLAUDE pattern, which the plan already applies via the exported pure helper + direct unit tests. Consistent with the plan's own `cairn:` line.

## Criteria findings

### 1. Fix 1 — cited-only citations (PASS)
- BOTH paths handled. Plan applies `selectCitedCitations` in the live-LLM path (`{ answer: text, citations: selectCitedCitations(text, buildCitations(chunks)) }`) and in `offlineAnswer`. Verified against `generate.ts`: these are the ONLY two sites that emit `citations: buildCitations(chunks)`. The empty-chunks short-circuit (line 95) and the non-text branch (line 142) already return `[]` and are correctly left untouched.
- Original numbers kept (no renumber). Filtering the `buildCitations` array (numbered 1..N) by the set of `[N]` parsed from the answer preserves each citation's `number`. AC "foo [2] … bar [4] → exactly citations [2],[4]" pins this and is satisfied by citation-order filtering.
- Empty when no markers. NO_CONTEXT_ANSWER / refusals contain no `[N]` → `[]`. Correct.
- Existing-test interaction correctly identified. The live-path 2-chunk test ("chunks produce an answer plus a citations array…") currently asserts length 2; the stub answer cites only `[1]` (verified `tests/__stubs__/anthropic-sdk.js:42` — `…directly [1].`), so cited-only filtering yields exactly 1 citation `{number:1, source:"vpn-guide.txt", heading:"VPN Setup"}` — which equals `buildCitations(chunks)[0]`. Plan flags this as an intended UPDATE, not a regression. Sound.
- Exported pure helper is the right both-ends approach. The stub only ever cites `[1]`, so the [2]/[4] multi-citation case is unreachable through `generateAnswer`; exporting `selectCitedCitations` makes the filter directly unit-testable. Correct.

### 2. Fix 2 — prompt reorder (PASS)
- Honesty rule preserved — plan keeps the "if context insufficient, say you couldn't find it" clause while leading with found-content framing.
- No test asserts exact prompt text — VERIFIED: `grep -rn "SYSTEM_PROMPT|You answer factually|couldn't find the information" tests/` → zero matches. Prompt-only change breaks nothing. The `empty chunks` test matches a refusal regex on the ANSWER, not the prompt, so it is unaffected.

### 3. Fix 3 — title sanitize (PASS)
- Approach (escape `& < >`, strip `* ~ \``, keep `_`) is sound and non-destructive. `& < >` escaping is exactly Slack mrkdwn's required HTML-entity encoding; `* ~ \`` are emphasis/code chars with no legitimate place in a filename/heading and are the stray-`**` culprit. Keeping `_` is correct (legal in filenames; only italicizes in matched pairs).
- Neutralizes the `**` problem. Stripping `*` from `c.source`/`c.heading` removes the literal `**`. The `*[${n}]*` bold wrapper around the citation NUMBER is NOT sanitized (sanitize applies only to source/heading), so `[N]` still renders bold. Correct seam.
- Existing formatter tests stay green. All fixtures (`vpn-guide.txt`, `wfh.md`, `guide.md`, `hr-policy.txt`, heading `Setup`) contain no sanitized chars → unchanged output. Verified against `tests/slack-formatter.test.ts`.

### 4. Scope guard (PASS)
- Plan's Scope section explicitly lists `src/slack/adapter.ts` and `src/slack/commands.ts` as INTENTIONALLY untouched (concurrent rename PR owns them). Confirmed `adapter.ts` imports `generate` and consumes `citations`, but the cited-only behavior change flows through it WITHOUT editing it (adapter formats whatever citations it receives). No scope violation.

### 5. Binary AC (PASS — observable)
- AC1 `npm run build` exit 0, AC2 `npm test` exit 0, AC3 `git grep` privacy clean — all checkable from outside the diff via command exit codes. AC2's sub-bullets describe observable helper behaviors (new helper unit tests + the updated live-path assertion). Acceptable.

### 6. Correctness traps / edge cases (none blocking)
- LATENT-BUG FIX (positive). In `offlineAnswer`, when all chunk text is empty, `body.length===0` currently returns `NO_CONTEXT_ANSWER` WITH a non-empty `buildCitations(chunks)`. Under cited-only filtering that becomes `[]` (no `[N]` in the sentinel) — consistent with intent, not a regression.
- Single-chunk offline test (`MONDAY_TEST_MODE=1`) stays green: answer appends `[1]`, citations=[{number:1}] → filter keeps it. Plan doesn't call this out explicitly but it remains green (confirmation, not a required change).
- Citation ORDER: filtering the `buildCitations` array yields citation-number order (`[2],[4]`), matching the AC even if the answer mentions `[4]` before `[2]`. Duplicate `[1][1]` dedupes via a set; out-of-range markers (e.g. `[9]` with 5 chunks) safely drop. All handled by the natural impl.

## Required changes
None. Plan is implementable as written.

## Optional (non-blocking) suggestions
- Consider noting in the plan that the single-chunk offline test stays green and that the empty-body offline case now correctly returns `[]` — purely confirmatory, no action required.
