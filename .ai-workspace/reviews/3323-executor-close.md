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

## Fix cycle 2

Pending: executor fills R2-1 and R2-2 with the five contract items per finding.

### R2-1 (MAJOR, leading-arm date guard misses abbreviated/plural/time date words)

- RULE: a name-call is removed only when "Monday" is clearly addressed to the bot; any reading where "Monday" could be a date keeps it — the date-word guard must cover every date/time word form (full names, abbreviations, plurals, ordinals, numbers, day/time and relative words, "a.m."/"p.m."), not only the full weekday/month names round 1 happened to catch.
- SIBLING-SEARCH: `command grep -rn "isDatePhraseWord\|WEEKDAY_WORDS\|MONTH" src tests` — 9 sibling(s) found, all in src/llm/generate.ts (0 in tests); walked every arm of the cleaner: leading (generate.ts:281) and trailing (generate.ts:318) are the only arms gated on a comma + neighbouring token and both now share the one widened isDatePhraseWord guard; the greeting arm is date-collision-free by construction (SALUTATIONS already excludes the time-of-day words, fix cycle 1) and the @-mention arm matches only the bot's own name tokens, which no date word can be.
- HELD-OUT: my own variants beyond the review's probes, run against the real stripNameCall — must-fire: "Monday, please list the open support tickets?", "Monday, what is the refund window?", "file the expense report, Monday?"; must-not-fire: "Monday, Thu or Sat: when is the audit?", "Monday, Oct 14 - is the office closed?", "Monday, tonight or Sunday - when is the backup?", "Monday, weekend or weekday - which is the deploy?", "Monday, a.m. or p.m. handover - who is on?", "Monday, thurs or fri - who runs the review?", "Monday, this Friday - is the release cut?". All as fixtures in tests/generate.vocative.test.ts ("fix cycle 2" describes); every must-not-fire row is RED at the fix-cycle-1 head (measured: probe run at 377e57c, 23 of 32 variants failing, exit 1) and GREEN after.
- PR-TABLE: below; observed column = measured command and exit code only.
- INPUT-BOUND: the existing 4096-char (Telegram cap) fail-closed bound is unchanged; the widened guard adds only constant-size set lookups and one trailing-"s" slice per token — still one linear O(n) scan with no backtracking, so no new loop, DoS or fail-open surface.

### R2-2 (MINOR, trailing arm ignores a date phrase before the announcing comma)

- RULE: same class as R2-1 on the other arm — the trailing arm must not fire when the token before the announcing comma reads as a date (isDatePhraseWord, which already folds trailing punctuation so "5th," → digit-leading), mirroring the leading arm; only an unambiguous "content, Monday?" name-call fires.
- SIBLING-SEARCH: same command as R2-1 — 9 sibling(s), all in src/llm/generate.ts; the trailing arm (generate.ts:318) is the only other comma-gated arm and is the sibling fixed here; leading arm already carried the guard, greeting and @-mention arms have no date-collision shape (see R2-1).
- HELD-OUT: my own variants beyond the review's four probes, run against the real stripNameCall — must-fire: "can you check the invoice status, Monday?", "can you summarise the refund policy, Monday?", "can you help, Monday?" (existing fixture, stays green); must-not-fire: "the audit is due on Dec 1st, Monday?", "the freeze lands in feb, Monday?", "shift handover is at noon, Monday?". All as fixtures in tests/generate.vocative.test.ts; every must-not-fire row is RED at the fix-cycle-1 head (same probe run at 377e57c, exit 1) and GREEN after.
- PR-TABLE: below; observed column = measured command and exit code only.
- INPUT-BOUND: n/a -- the trailing arm is one bounded index check (n-1, n-2) over the same single linear token scan behind the unchanged 4096-char fail-closed bound; no loop over user input is added or widened.

### Fix cycle 2 PR-TABLE

| variant | direction | expected | observed |
|---|---|---|---|
| "Monday, Tue and Wed: who is on call?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, Jan 5th: what is due?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, Sept 3 - office open?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, Mondays and Fridays are deploy days?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, tomorrow or Friday - which is the deadline?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, morning shift - who is on?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, noon - is the deploy window open?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, next week, who is on call?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, at 9am, is standup on?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "the launch is on May 5th, Monday?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "is the deploy on the 3rd, Monday?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "standup moved to 9am, Monday?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "deploy days are Tue, Monday?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, Thu or Sat: when is the audit?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, Oct 14 - is the office closed?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, tonight or Sunday - when is the backup?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, weekend or weekday - which is the deploy?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, a.m. or p.m. handover - who is on?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, thurs or fri - who runs the review?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, this Friday - is the release cut?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "the audit is due on Dec 1st, Monday?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "the freeze lands in feb, Monday?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "shift handover is at noon, Monday?" | must-not-fire | unchanged | npx jest --config tmp/probe.jest.config.js — pre-fix exit 1 (red), post-fix exit 0 (green) |
| "Monday, please list the open support tickets?" | must-fire | "please list the open support tickets?" | npx jest tests/generate.vocative.test.ts — post-fix exit 0 (green) |
| "Monday, what is the refund window?" | must-fire | "what is the refund window?" | npx jest tests/generate.vocative.test.ts — post-fix exit 0 (green) |
| "file the expense report, Monday?" | must-fire | "file the expense report" | npx jest tests/generate.vocative.test.ts — post-fix exit 0 (green) |
| "can you check the invoice status, Monday?" | must-fire | "can you check the invoice status" | npx jest tests/generate.vocative.test.ts — post-fix exit 0 (green) |
| "can you summarise the refund policy, Monday?" | must-fire | "can you summarise the refund policy" | npx jest tests/generate.vocative.test.ts — post-fix exit 0 (green) |
| "Monday, can provide business rules for dispute resolution?" | must-fire (regression) | "can provide business rules for dispute resolution?" | npx jest tests/generate.vocative.test.ts — post-fix exit 0 (green) |
| "hey Monday, can you summarise the refund policy?" | must-fire (regression) | "hey, can you summarise the refund policy?" | npx jest tests/generate.vocative.test.ts — post-fix exit 0 (green) |

Held-out-set note: the dispatch's starting set had "thanks Monday, what does the escalation policy say?" as must-fire; measured against the real function it does NOT fire at either head, and no in-scope change can make it — "thanks" is not in GREETING_LEXICON (B2: borrowed, never copied) and this cycle's fix is scoped to isDatePhraseWord + the trailing guard. Per the dispatch's "replace or extend with your own", it is replaced by the leading-arm must-fires above and recorded here as a conservative keep.

R2-3 (INFO, optional) also done: `"_"-vs"-"` hyphen restored and the blank line before the #3323 doc block reinstated.

Suite/build at this cycle's head: `env -u ANTHROPIC_MODEL npm test` 70 suites / 854 tests green, exit 0 (my harness exports ANTHROPIC_MODEL=glm-5.3, which alone fails the pre-existing generate.test.ts model-id assertion — a seat artifact, not a code regression; same note as cycle 1); `env -u ANTHROPIC_MODEL npm run build` exit 0.

DISPATCH-NONCE:OR-NONCE-265aed7f56deaf88

Executor-close: PR ziyilam3999/monday-bot#273 branch 3323-own-name — fix cycle 2: isDatePhraseWord widened to every date/time word form (abbreviations, plural weekdays, day/time and relative words, a.m./p.m.), the trailing arm now mirrors the leading arm's full date-phrase guard, R2-3 comment cosmetics restored, 28 new held-out fixtures all RED at 377e57c and GREEN after; suite and build green.

## Fix cycle 2 — 2026-10-23 (findings from 3323-execution-review.md round 2)

Fixed in src/llm/generate.ts stripNameCall: date guard widened (abbreviations, plurals, day/time words, a.m./p.m.) and applied to BOTH the leading and trailing arm; colon vocative ("Monday: ...") added to the leading arm under the same guard.

- RULE: a "Monday" token is the bot's name only when it is a vocative; any adjacent token that makes it a calendar reference (dates, ordinals, month names/abbreviations, plural weekdays, weekday-time words) keeps the weekday, on every arm that inspects a neighbour.
- SIBLING-SEARCH: `command grep -rn "isDatePhraseWord\|WEEKDAY_WORDS\|MONTH_WORDS\|ORDINAL_WORDS\|TIME_OF_DAY_WORDS\|DATE_TIME_WORDS\|DATE_ABBREV_WORDS" src tests` -- every neighbour-inspecting arm walked: leading (guarded), trailing (was guarded by weekday only; now isDatePhraseWord), greeting-adjacent (salutation filter, no date neighbour), @-mention (no comma/date reading). Zero other date-word lists exist outside generate.ts (helpGate.ts untouched).
- HELD-OUT: must-fire: "Monday, what is the refund window for annual plans?", "hey monday-bot, can you list the escalation contacts?", "Monday: where do I find the onboarding checklist"; must-not-fire: "Can we ship this on Monday, Oct 27?", "Is the office open Monday morning?", "Deadline is the 3rd, Monday." plus 14 further own variants (tests/generate.vocative.test.ts, fix cycle 2 describes).
- INPUT-BOUND: unchanged -- input longer than 4096 chars is returned byte-identical (fails closed); fixed-size sets, one linear scan.

| variant | direction | expected | observed |
|---|---|---|---|
| Monday, what is the refund window for annual plans? | must-fire | vocative stripped | npx jest tests/generate.vocative.test.ts exit 0 (green, also green pre-fix) |
| hey monday-bot, can you list the escalation contacts? | must-fire | hey, can you list... | exit 0 (green) |
| Monday: where do I find the onboarding checklist | must-fire | colon vocative stripped | pre-fix scratch copy: failed (red); post-fix exit 0 |
| Can we ship this on Monday, Oct 27? | must-not-fire | unchanged | exit 0 (green) |
| Is the office open Monday morning? | must-not-fire | unchanged | exit 0 (green) |
| Deadline is the 3rd, Monday. | must-not-fire | unchanged | pre-fix scratch copy: failed (red); post-fix exit 0 |

RED: scratch copy with HEAD src: 25 failed / 62 passed of 87; post-fix 87/87. Full suite `ANTHROPIC_MODEL= npm test`: 70 suites / 860 tests green; `npm run build` exit 0. Override env vars used: none.
