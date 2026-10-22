# 3323 executor close — re-plan build (keep-by-default allowlist cleaner)

Plan: .ai-workspace/plans/2026-10-23-3323-own-name-replan.md (plan-review round 4 PASS).
Branch 3323-own-name, PR ziyilam3999/monday-bot#273. Built on the Claude fallback path (z.ai quota closed).
This file replaces the earlier per-fix-cycle account; it is the one authoritative record.

Files: src/llm/generate.ts (prompt clause + cleaner rewritten, old date word sets and isDatePhraseWord deleted),
tests/fixtures/3323-vocative-corpus.json (new), tests/generate.vocative.test.ts (rewritten to drive the corpus),
tests/generate.prompt-integrity.test.ts (#3323 assertions rewritten; master-era assertions unedited).
helpGate.ts, adapters, queryHandler, service.ts, retrieval untouched.

## Design as built

- Default = keep byte-identical. Removal only on a closed allowlist.
- Arm U: unambiguous name token (derived from BOT_NAME_TOKENS: every token except the single bare weekday spelling) as first token with comma/colon, right after one salutation, last token with an announcing comma, or any @-mention of a name token.
- Arm A: ambiguous "Monday" + announcing comma (attached or standalone), optional single SALUTATIONS word (no good/morning/afternoon/evening), then a body that opens with: auxiliary + "you"; request verb + "me"; or "please" + an information-asking verb (list, explain, summarise, ...) or "me".
- Review note 2 (B3 wording correction): the plan's B3 says arm A "removes only the name and its announcing comma". As built and per AC-9, with a salutation the comma moves to the salutation ("hey Monday, can you ..." -> "hey, can you ..."). The AC is the contract; the B3 sentence is hereby corrected.
- Review note 5 (named risk 3323-please-opener-date): "please" is not a blanket opener. It counts only before an information-asking verb, so "Monday, please submit timesheets - is that the rule?" keeps its weekday (must-not-change corpus entry plus a named test). Residual risk: a memo whose verb is on the allowlist ("Monday, please list the attendees - is that the rule?") would still lose "Monday"; accepted and left to the prompt clause.
- Prompt clause rewritten per B4: names Monday Bot, gives the operator example as a name-call, keeps date meaning when the weekday is needed ("on the 3rd, Monday?", "Monday: who is on call?"), says a name-call is "never something to answer about". Quotes are escaped so the quoted token literal appears nowhere in the file (AC-12).
- Doc comments avoid the call-syntax token (AC-16 counts calls).

## Binary AC

| AC | Result | Evidence |
|---|---|---|
| AC-1 corpus file driven by suite | MET | fixture has keep (104) + fire (20) entries; suite iterates both, one test each |
| AC-2/3/4 round 1-3 counterexamples keep | MET | all in `keep`, green |
| AC-5 prior keep sets | MET | green |
| AC-6 decided reversals keep | MET | green |
| AC-7 anti-denylist (>= 12) | MET | 12 invented-word entries; suite asserts the count; green |
| AC-8 held-out keep families | MET | green |
| AC-9 / AC-10 / AC-11 fire | MET | exact outputs green (20 fire entries) |
| AC-12 single source | MET | suite loops BOT_NAME_TOKENS; `command grep -c '"monday-bot"' src/llm/generate.ts` = 0 |
| AC-13 deletion-only | MET | subsequence + non-empty asserted over all fire entries |
| AC-14 no date vocabulary | MET | `stripNameCall.toString()` has none of the six words; old sets/guard symbols absent from the file |
| AC-15 prompt clause | MET | (a)-(d) pinned: "Monday Bot", `"Monday"`, "monday-bot"; operator example; the two literal examples + "keeps its date meaning"; "never something to answer about"; `/never a date/i` absent |
| AC-16 wiring + bound | MET | `command grep -c "stripNameCall(" src/llm/generate.ts` = 2; suite counts non-comment call lines = 1; 4097 chars identical, 4096 chars cleaned |
| AC-17 RED/GREEN | MET | below |

## RED / GREEN

RED: `git archive f4122cc` into a scratch dir (node_modules symlinked, no stash/reset), new test files + fixture copied in,
`npx jest tests/generate.vocative.test.ts tests/generate.prompt-integrity.test.ts` -> 65 failed, 87 passed (152 tests).
Failing set includes: AC-4 colon entries ("Monday: who is on call?", "Monday: standup cancelled?", "Monday: where do I find the onboarding checklist"),
AC-4 greeting entries ("hi Monday, Tuesday and Wednesday: who is on call?", "hey Monday, May 5th is the launch?", ...), AC-6 ("Monday, can provide business rules ...",
"Monday, who is on call?", "HELLO MONDAY ..."), AC-7 (all invented-word entries incl. "Monday, zorblax deploys - who is on call?"), the please memo case,
the trailing-"?" fire case, AC-14 (date vocabulary present), and all five rewritten prompt-integrity assertions.
Two new arms are NOT red at f4122cc because the old code already excluded time-of-day salutations ("evening Monday, can you cover the shift?"): they are regression guards (review note 4), not RED proofs.

GREEN at the new head: `ANTHROPIC_MODEL= npm test` -> 70 suites passed, 917 tests passed; `npm run build` exit 0; `npx tsc --noEmit` exit 0. No new test constructs a model client.

## Live smoke (Rule 18, review note 6)

Script (kept outside the repo) calls the built generateAnswer with a two-chunk synthetic context and asks the operator example and "is the deploy on the 3rd, Monday?".
Auth resolved (OAuth) and the request reached the API, but both attempts (one retry after 45 s) returned HTTP 429 rate_limit_error (request ids req_011CgHq3dABDkiBDRtCUuPu4, req_011CgHq7Zo8SNnFEAUn32qfE).
RESULT: NOT MEASURED. The cleaned-question side was observed: the operator example is left unchanged by the cleaner (by design, prompt clause is its only guard); the model answer is unproven.
The orchestrator must re-run `env -u MONDAY_TEST_MODE node <smoke script> <worktree path>` once the rate limit clears and record the two answers before ship-tail.

## Notes

- override env vars used: none.
- Merged origin/master: not needed (0 commits behind).
