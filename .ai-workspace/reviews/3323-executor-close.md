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
