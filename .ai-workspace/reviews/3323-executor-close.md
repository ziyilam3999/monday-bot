# 3323 executor close — the bot knows its own name

DISPATCH-NONCE:OR-NONCE-db64735ac0608af0

Branch 3323-own-name, head 21a9912. One code file (src/llm/generate.ts) plus
tests/generate.vocative.test.ts (new) and tests/generate.prompt-integrity.test.ts
(extended). helpGate.ts untouched; no second name list anywhere.

## Binary AC — observed results

- **AC-1 (leading name-call removed)** MET — `stripNameCall("Monday, can provide business rules for dispute resolution?")` → `"can provide business rules for dispute resolution?"`; all-caps `"MONDAY, what about the refund policy?"` → `"what about the refund policy?"` (green in tests/generate.vocative.test.ts).
- **AC-2 (greeting-adjacent, greeting kept)** MET — `"hey Monday, can you summarise the refund policy?"` → `"hey, can you summarise the refund policy?"` (name gone, greeting + its announcing comma kept).
- **AC-3 (trailing name-call removed)** MET — `"can you help, Monday?"` → `"can you help"`.
- **AC-4 (@-mention removed, weekday kept)** MET — `"hey @monday_bot what is due on Monday?"` → `"hey what is due on Monday?"`.
- **AC-5 (weekday must-not-fire, byte-identical)** MET — all four corpus inputs ("what was deployed on Monday?", "is the standup on Monday?", "deploy runs every Monday at noon", "what changed in the Monday release?") returned byte-identical (strict `toBe`).
- **AC-6 (mixed name-call + real date)** MET — `"Monday, what is due on Monday?"` → exactly `"what is due on Monday?"`.
- **AC-7 (prompt identity)** MET — SYSTEM_PROMPT now carries "YOU ARE MONDAY BOT", the address forms "Monday"/"monday-bot", the CALL POSITION / VOCATIVE / NEVER-a-date / never-content rule, and the weekday-as-date preservation ("what was deployed on Monday" KEEPS its date meaning); pinned by three new phrase assertions in tests/generate.prompt-integrity.test.ts. All pre-existing prompt-integrity assertions still green.
- **AC-8 (one source of truth)** MET — the cleaner imports BOT_NAME_TOKENS (and GREETING_LEXICON) from src/telegram/helpGate.ts; the single-source test block iterates BOT_NAME_TOKENS itself, so a future token is covered with no test edit.
- **AC-9 (upstream parity)** MET — the cleaner is applied only at the `Question:` line inside generateAnswer (downstream of the empty-chunks and offline/test-mode guards); handleQuery, both adapters, the #3306 help gate, the #3299 exact-key leg and the ask log are untouched and their full test corpus (telegram-help-card, telegram-help-gate, queryHandler, slack-adapter, key-lookup, …) passed without edits: 70 suites / 805 tests green.
- **AC-10 (suite health, RED→GREEN, no live model)** MET — both new/extended test files FAIL on a pristine origin/master scratch checkout (missing export / missing clauses: 2 suites failed, 3 tests failed) and PASS at head; `npm test` green at head (70 suites / 805 tests); `npm run build` (tsc) green; no new test constructs or invokes a model client (pure-function + constant-string tests only).

## Environment note

This dispatch session's environment exports `ANTHROPIC_MODEL`, which the repo's
own documented override contract (`resolveModel`, modelConfig.ts) honors — one
pre-existing test ("sends no sampling parameter and the resolved default
model") sees the session's override instead of the default model id. With the
override emptied (`ANTHROPIC_MODEL= npm test`, the app's own "empty means
unset" contract) the full suite is green, including that test. Pre-existing on
origin/master; unrelated to this diff.

Executor-close: PR #273 (draft, into master) ships commit 21a9912 — the stripNameCall vocative cleaner + SYSTEM_PROMPT identity clause in src/llm/generate.ts with fixture-only tests, all ten Binary AC observed green, full suite (70/805) and npm run build green.

## Fix cycle 1 — 2026-10-22 (dispatch OR-NONCE-77781f7506a25693, findings 1/2/3 from 3323-execution-review.md)

Commit 62a4f06 on 3323-own-name. All three findings fixed in the one seam
(src/llm/generate.ts stripNameCall) plus review finding 4 via the shared
weekday-neighbour guard. helpGate.ts untouched (its tests green).

- RULE: a name-call is removed only when "Monday" is clearly addressed to the bot; any reading where "Monday" could be a date keeps it — a comma after a weekday/month-adjacent token is not by itself a vocative marker (date-word collision class), and a fired arm must not disturb whitespace it did not consume.
- SIBLING-SEARCH: `command grep -rn "GREETING_LEXICON\|BOT_NAME_TOKENS" src tests` — 17 sibling(s) found; walked every arm of the cleaner (leading, greeting-adjacent, trailing, @-mention): leading and trailing carried the same date-collision shape (both now guarded by weekday/month/ordinal/digit/"the" neighbour checks), the greeting arm collided via the time-of-day words in GREETING_LEXICON (now filtered to SALUTATIONS at this seam only), and the @-mention arm is name-matched with no comma involvement (no date reading possible). helpGate's own use of the lexicon is the card gate, deliberately untouched per the brief.
- HELD-OUT: 8 must-fire and 13 must-not-fire variants, all as fixtures in tests/generate.vocative.test.ts ("fix cycle 1" describes), run against the real stripNameCall; 17 of them FAILED on pre-fix head e671c9b (measured: `npx jest tests/generate.vocative.test.ts` exit 1, "17 failed, 36 passed") and all PASS after (exit 0).
- PR-TABLE: below; observed column = measured `npx jest tests/generate.vocative.test.ts` (pre-fix head exit 1 with the listed failures; post-fix exit 0, 53/53).
- INPUT-BOUND: stripNameCall returns the input byte-identical (fails closed) when question.length > 4096 — Telegram's own hard message cap, so no real ask is declined and no tokenization loop can be driven by oversized input; every per-token step is O(n) over one linear scan with fixed-size constant sets (no backtracking regex).

| variant | direction | expected | observed |
|---|---|---|---|
| "Monday, can provide business rules for dispute resolution?" | must-fire | "can provide business rules for dispute resolution?" | npx jest tests/generate.vocative.test.ts — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "hey Monday, can you summarise the refund policy?" | must-fire | "hey, can you summarise the refund policy?" | npx jest tests/generate.vocative.test.ts — post-fix exit 0 (green) |
| "can you help, Monday?" | must-fire | "can you help" | npx jest tests/generate.vocative.test.ts — post-fix exit 0 (green) |
| "yo MONDAY, summarise the refund policy?" | must-fire | "yo, summarise the refund policy?" | npx jest tests/generate.vocative.test.ts — post-fix exit 0 (green) |
| "Monday, Tuesday and Wednesday: who is on call?" | must-not-fire | unchanged | npx jest tests/generate.vocative.test.ts — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, May 5th is the launch?" | must-not-fire | unchanged | npx jest tests/generate.vocative.test.ts — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "morning Monday standup?" | must-not-fire | unchanged | npx jest tests/generate.vocative.test.ts — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "good morning, is the deploy on Monday?" | must-not-fire | unchanged | npx jest tests/generate.vocative.test.ts — post-fix exit 0 (green) |
| "Monday,\nwhat about leave?\nsecond line" | must-fire (whitespace kept) | "what about leave?\nsecond line" | npx jest tests/generate.vocative.test.ts — pre-fix exit 1 (red), post-fix exit 0 (green) |
| 4105-char "Monday, xxx…" | must-not-fire (bound) | unchanged | npx jest tests/generate.vocative.test.ts — pre-fix exit 1 (red), post-fix exit 0 (green) |

Suite/build at 62a4f06: `ANTHROPIC_MODEL= npm test` 70 suites / 826 tests green, exit 0 (the single generate.test.ts model-id failure seen with the session's stray ANTHROPIC_MODEL export is the pre-existing environment note above); `npm run build` exit 0. Full-fix run also re-verified helpGate suites untouched and green.

Executor-close: PR ziyilam3999/monday-bot#273 branch 3323-own-name pushed 62a4f06 — fix cycle 1: date-word guards on the leading/trailing arms, true-salutation filter on the greeting arm, whitespace-preserving rebuild, 4096-char fail-closed bound, 17 held-out fixtures RED→GREEN; suite and build green.
