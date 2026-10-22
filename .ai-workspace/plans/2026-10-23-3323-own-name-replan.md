# 3323 — the bot knows its own name (RE-PLAN at fix-loop cap)

Repo: monday-bot (public) · Branch: 3323-own-name · Date: 2026-10-23 · Focus: Answer correctness (own-name vs weekday misread)

size: M
data-class: public
Ticket: #3323
cairn: `cairn-find --task 3323 "allowlist"` -> [T1] 2026-10-02 scratch: "When a hook or guard exempts text from scanning, exempt only on positive proof ..." and [T1] 2026-09-27: "When detecting a prefix/word-boundary condition, prefer an allowlist ..." -- act only on positive proof, never on the absence of a listed counter-word; this re-plan applies that to the name cleaner. `"denylist"` -> [T1] 2026-10-08: "A denylist regex ... won't match identifiers joined by `_`" (denylists fail open on unlisted shapes).
Supersedes: .ai-workspace/plans/2026-10-22-3323-own-name.md (kept for history; this file is the contract from now on).
REPLAN-AT-CAP: 3323 · ROOT-CAUSE-CLASS: instance-not-class · REVIEW-ROUNDS: .ai-workspace/reviews/3323-execution-review.md (rounds 1-3), .ai-workspace/reviews/3323-plan-review.md

Size note: M, not S. One production file (src/llm/generate.ts) but the test contract is rewritten (existing must-fire fixtures flip to must-not-change, a new shared fixture corpus file, prompt-integrity assertions change). It also must pass plan-review: a plan-review PASS of this re-plan is what resets the fix-loop counter for one build (#2861), and an S stamp would skip that seat.

## ELI5

Users call the bot "Monday". "Monday" is also a day of the week. The bot kept reading its own name as the day.

Last time we tried to fix it with a list of "date words": if the word after "Monday," was on the list (Tuesday, May, 3rd, noon...), we left "Monday" alone; otherwise we deleted it. Three reviews in a row found a date word that was not on the list (eleventh, EOD, midday, "or Friday"...), and each time the bot deleted a real date. The list can never be complete, so that approach can never be finished.

The new rule flips it around. By default we delete NOTHING, so the text reaches the model exactly as it does today. We only delete the name when the sentence shape proves it is a name:
- the name is written in a form that can never be a date ("monday-bot", "@monday_bot"), or
- "Monday," is followed by words that are plainly talking to the bot ("Monday, can you...", "Monday, please...", "Monday, tell me...").

Everything else -- every unknown word, every date list, every header like "Monday: who is on call?" -- is left alone. A word we never thought of now means "keep", not "delete". For all the cases in between, the bot's standing instructions now say: "Your name is Monday Bot. People may call you 'Monday'. Decide from the meaning whether 'Monday' is your name or the day; if the question needs the day to make sense, it is the day." The model is good at that kind of judgement; a word list is not.

## Root cause and why this design (intent)

- The original root cause (ticket): SYSTEM_PROMPT never told the model it is called Monday, so "Monday, can provide business rules...?" was read as a weekday.
- The fix-loop root cause (instance-not-class): the cleaner's default was DELETE; its guards were a denylist of date words. Any unlisted calendar word fails OPEN and removes a real weekday that origin/master would have passed intact. Every round patched instances (abbreviations, plurals, ordinals, connectors) and the next round found more.
- Class fix: invert the default. Deletion happens only on a closed ALLOWLIST of shapes that cannot be a date. Unknown input fails CLOSED to byte-identical (today's master behaviour). The judgement for ambiguous shapes moves to the model through a corrected prompt clause.
- Considered and rejected: (a) "never delete, prompt only" -- safe, but drops the cheap, provably-safe wins (@-mentions and the hyphen/underscore name forms carry zero date ambiguity), and leaves the ticket with no deterministic AC at all; (b) keep widening the denylist -- rejected by three review rounds.
- The current prompt clause is itself part of the class bug: it says a name in "call position -- leading, after a greeting, trailing" is "NEVER a date". "is the deploy on the 3rd, Monday?" and "Monday, who is on call?" are in those positions and ARE dates. The clause must stop asserting position = name and instead ask for a meaning-based decision.

## Determined boundaries

**B1 -- One production file, one seam.** src/llm/generate.ts only: the SYSTEM_PROMPT clause and the exported pure cleaner `stripNameCall`, still applied only where the `Question:` line is built in `generateAnswer`. Adapters, helpGate.ts, queryHandler, service.ts, retrieval and the ask log are untouched and keep seeing the original text.

**B2 -- Name vocabulary stays borrowed.** BOT_NAME_TOKENS (and the salutation words) still come from src/telegram/helpGate.ts; helpGate.ts is not edited. A name token that also spells a weekday ("monday") is AMBIGUOUS; every other name token and every @-mention of a name token ("monday-bot", "monday_bot", "@monday", "@monday_bot") is UNAMBIGUOUS. This split is derived from the borrowed constant, so a future name token is classified with no extra list.

**B3 -- Allowlist arms (default = keep byte-identical).** The cleaner removes text only in these shapes; any other input is returned byte-identical:
- **U (unambiguous name form)**: an unambiguous name token in a call position -- first token followed by an announcing comma or colon; right after a single salutation word; last token announced by a comma; or any @-mention token anywhere. Removes the name token and its announcing punctuation. A mid-sentence unambiguous name that is content ("what is the monday-bot repo?") is not a call position and is kept.
- **A (ambiguous "Monday" -- second-person opener only)**: optionally one salutation word, then the ambiguous name, then an announcing comma (attached or standalone), then a body that opens by plainly addressing the bot: an auxiliary/modal immediately followed by "you" ("can you", "could you", "would you", "will you", "do you", "are you", ...), or "please", or a request verb immediately followed by "me" ("tell me", "show me", "give me", "help me"). Removes only the name and its announcing comma; the salutation and the whole body stay.
- **Explicitly NOT arms** (decided, not oversights): bare "Monday" with a colon ("Monday: ...") -- calendar-header shape, kept (this reverses the unapproved colon arm from fix cycle 2, per R3-2); trailing bare "..., Monday?" -- kept (date-confirmation shape, R2-2/R3-4); "Monday, <wh-word> ..." ("Monday, who is on call?") -- kept, because "for Monday, who is on call?" is a natural date-topic reading; greeting + "Monday" with no comma, or with a non-allowlisted body -- kept.
- Kept from the prior contract: whitespace-preserving splice (only removed tokens and their announcing punctuation/space change; interior newlines and space runs survive), and the >4096-character fail-closed bound.
- The opener allowlist may grow later; growth can only add strips for shapes that address the bot, and an unknown word can never cause a strip. No date-word list of any kind is needed or kept.

**B4 -- Prompt clause (intent; executor words it).** The clause must (1) name the assistant: Monday Bot, addressed as "Monday" / "monday-bot"; (2) say that "Monday" at the start, after a greeting, or at the end MAY be the user calling the bot by name, and give the operator's literal example ("Monday, can provide business rules for dispute resolution?") as a name-call; (3) say that when the weekday is needed for the question to make sense -- a list of days, a date confirmation ("on the 3rd, Monday?"), a calendar header ("Monday: who is on call?"), a schedule -- it keeps its date meaning; (4) say a name-call is never something to answer about (no "on Monday" in the reply when the user only called the bot). It must NOT state that a call-position name is unconditionally never a date. Existing master-era prompt-integrity assertions stay green unedited; the #3323-added assertions are rewritten to pin (1)-(4).

**B5 -- No new knobs.** No env var, config or kill switch.

## Binary AC

All checks run from outside the diff: a jest run, a JSON corpus file's contents, and the exported SYSTEM_PROMPT string. No live model call in any test.

The canonical corpus lives in ONE data file, `tests/fixtures/3323-vocative-corpus.json`, with two arrays: `keep` (strings that must come back byte-identical) and `fire` (objects `{ "in": ..., "out": ... }`). `tests/generate.vocative.test.ts` iterates it. A reviewer checks presence with `node -e` (read the JSON, assert each listed string is in `keep`) and behaviour with `npx jest tests/generate.vocative.test.ts`.

- **AC-1 (corpus file exists and is driven by the suite)**: `tests/fixtures/3323-vocative-corpus.json` parses as JSON with non-empty `keep` and `fire` arrays, and `npx jest tests/generate.vocative.test.ts` exits 0 with at least one test per corpus entry (test count >= keep.length + fire.length).

- **AC-2 (every round-1 counterexample is must-not-change)** -- in `keep`: "Monday, Tuesday and Wednesday: who is on call?", "Monday, Wednesday, Friday deploys - what is the schedule?", "Monday, May 5th: what is due?", "Monday, the 3rd - is the office open?", "morning Monday standup?", "Afternoon monday meeting cancelled?", "evening Monday shift - who is on?", "which days are deploy days: Tuesday, Monday?".

- **AC-3 (every round-2 counterexample is must-not-change)** -- in `keep`: "Monday, Tue and Wed: who is on call?", "Monday, Jan 5th: what is due?", "Monday, Sept 3 - office open?", "Monday, Mondays and Fridays are deploy days?", "Monday, tomorrow or Friday - which is the deadline?", "Monday, morning shift - who is on?", "Monday, noon - is the deploy window open?", "Monday, next week, who is on call?", "Monday, at 9am, is standup on?", "the launch is on May 5th, Monday?", "is the deploy on the 3rd, Monday?", "standup moved to 9am, Monday?", "deploy days are Tue, Monday?".

- **AC-4 (every round-3 counterexample is must-not-change)** -- in `keep`: greeting shapes "hi Monday, Tuesday and Wednesday: who is on call?", "hey Monday, May 5th is the launch?", "hey Monday or Tuesday for the deploy?", "hi, Monday morning standup still on?", "hey, Monday 9am standup moved?", "hello, Monday is a holiday, right?", "yo Monday standup cancelled?"; colon shapes "Monday: who is on call?", "Monday: standup cancelled?", "Monday: where do I find the onboarding checklist"; leading word-list gaps "Monday, eleventh of May: what is due?", "Monday, twenty-first - is the office open?", "Monday, or Friday - which is the deadline?", "Monday, through Friday, who is on call?", "Monday, EOD - is the deadline firm?", "Monday, end of day - is the deadline firm?", "Monday, midday - is the office open?", "Monday, lunchtime - is the office open?", "Monday, every other week - is standup on?", "Monday, weekly or biweekly?", "Monday, two pm - is the office open?", "Monday, Labor Day - is the office open?" (the review truncated these with "- ..."; the completed tails are this plan's); trailing "the release is the twenty-first, Monday?", "deploy is EOD, Monday?", "standup is weekly, Monday?", "the deadline is the 3rd , Monday?".

- **AC-5 (prior plan's and round-1 keep sets stay must-not-change)** -- in `keep`: "what was deployed on Monday?", "is the standup on Monday?", "deploy runs every Monday at noon", "what changed in the Monday release?", "Monday, May 5th is the launch?", "Monday, the 3rd?", "good morning, is the deploy on Monday?", "Monday's release notes?", "on Monday, what shipped?", "every Monday we deploy, right?", "Monday morning standup?", "is it due Friday or Monday?", "standups are Tuesday, Thursday, and Monday", "Monday what was deployed", "the Monday deploy checklist".

- **AC-6 (decided reversals: former must-fire shapes now kept, prompt clause is the guard)** -- in `keep`: "Monday, can provide business rules for dispute resolution?", "MONDAY, what about the refund policy?", "Monday, what is due on Monday?", "Monday, who is on call?", "can you help, Monday?", "what about annual leave, Monday?", "HELLO MONDAY what about annual leave", "Monday, what is due, Monday?".

- **AC-7 (anti-denylist arm -- a denylist-only fix FAILS this)**: `keep` contains at least 12 entries of the shape "Monday, <W> ..." where W is a word that appears in no calendar vocabulary and is not a second-person opener -- including invented words ("Monday, zorblax deploys - who is on call?", "Monday, quuxday rota - who is on?"), non-date common words ("Monday, quarterly review - is it on?", "Monday, payroll - when does it run?", "Monday, holiday party - still on?", "Monday, sprint demo - who presents?"), and the same shapes behind a salutation ("hi Monday, zorblax deploys - who is on call?", "hey Monday, payroll - when does it run?"). A denylist matcher strips every one of these (W is on no date list); the allowlist keeps them. All byte-identical.

- **AC-8 (held-out must-not-change families, beyond any review round)** -- in `keep`, at least one entry per family: a second-person opener NOT addressing the bot ("Monday, can we move standup?"), a wh-body ("Monday, which room is standup in?"), an imperative with no "me" ("Monday, list the deploys"), a modal without "you" ("Monday, could the deploy slip?"), no space after the comma ("Monday,can you help?"), full-width comma ("Monday， can you help?"), bare name ("Monday", "Monday,", "Monday:"), plural/possessive name ("Mondays, can you check?", "Monday's, can you check?"), an unambiguous name used as content mid-sentence ("what is the monday-bot repo?"), and a non-bot @-mention ("ask @monday_fan about leave").

- **AC-9 (must-fire, ambiguous name, second-person opener)** -- in `fire`, each exact: "Monday, can you summarise the refund policy?" -> "can you summarise the refund policy?"; "hey Monday, can you summarise the refund policy?" -> "hey, can you summarise the refund policy?"; "Monday, please list the leave rules" -> "please list the leave rules"; "Monday, tell me who is on call Monday" -> "tell me who is on call Monday" (the real-date Monday survives); "Monday , could you check the 3rd?" -> "could you check the 3rd?" (standalone comma).

- **AC-10 (must-fire, unambiguous name forms)** -- in `fire`, each exact: "hey @monday_bot what is due on Monday?" -> "hey what is due on Monday?"; "@monday-bot, what about annual leave?" -> "what about annual leave?"; "hi monday-bot what about annual leave" -> "hi what about annual leave"; "monday-bot: who is on call Monday?" -> "who is on call Monday?"; "what is the refund policy, monday-bot?" -> "what is the refund policy?" (the "?" survives; only the name and its announcing comma go).

- **AC-11 (held-out must-fire families)** -- in `fire`, at least one per family, outputs exact: a different auxiliary ("Monday, would you explain the escalation path?"), a different salutation ("hello Monday, could you help me?"), "show me" / "give me" / "help me" openers, all-caps and mixed case ("MONDAY, CAN YOU HELP?"), underscore form ("Monday_Bot, what is due?"), and a multi-line body ("Monday,\ncan you help?\nsecond line" -> "can you help?\nsecond line").

- **AC-12 (single source of truth, by construction)**: the suite imports BOT_NAME_TOKENS from src/telegram/helpGate.ts and, for every token, asserts the "<token>, can you help?" shape fires; `command grep -c "\"monday-bot\"" src/llm/generate.ts` returns 0 (no second name list in the cleaner).

- **AC-13 (deletion-only property)**: for every `fire` entry, the output is obtainable from the input by deleting characters only (no character is inserted or reordered), and every output is non-empty. Asserted in the suite over the whole `fire` array.

- **AC-14 (no date vocabulary in the cleaner)**: src/llm/generate.ts no longer defines a date-word guard; the suite asserts `stripNameCall.toString()` (and any helper it calls, exported for the check or inlined) contains none of: "sept", "tomorrow", "midnight", "ordinal", "tue", "jan".

- **AC-15 (prompt clause)**: tests/generate.prompt-integrity.test.ts asserts SYSTEM_PROMPT (a) contains "Monday Bot", "\"Monday\"" and "monday-bot"; (b) contains the operator example "Monday, can provide business rules for dispute resolution?"; (c) states a weekday needed for the question's meaning (a list of days, a date confirmation, a calendar header) keeps its date meaning; and (d) does NOT contain the unconditional phrase "NEVER a date". Every assertion that exists on origin/master is unedited and green.

- **AC-16 (wiring and bound unchanged)**: `stripNameCall` is called exactly once in src/llm/generate.ts (`command grep -c "stripNameCall(" src/llm/generate.ts` counts the definition plus one call = 2); a 4097-character input is byte-identical; a 4096-character input that matches an arm is cleaned.

- **AC-17 (RED at the capped head, GREEN at the new head)**: with the new test files copied onto `git archive f4122cc` (the round-3 head), `npx jest tests/generate.vocative.test.ts` FAILS, and the failing set includes AC-4's colon and greeting entries, AC-6's entries and AC-7's entries; at the new head, `npx jest` (full suite), `npx tsc --noEmit` and `npm run build` all exit 0, and no new test constructs a model client.

## Execution model

Shape: delegate -- one briefable coherent surface (src/llm/generate.ts plus its tests); evaluator: both (the jest corpus suite is the test-oracle, plus the independent execution-review seat).

- Executor (size M, per routing): rewrite the cleaner to the allowlist contract in B3, rewrite the #3323 prompt clause per B4, move the corpus into the JSON fixture, rewrite tests/generate.vocative.test.ts to drive it (old fix-cycle describe blocks are replaced, not appended -- the corpus file is the single record), update the #3323-added prompt-integrity assertions only. Consolidate 3323-executor-close.md into one authoritative account (R3-6) with the AC-17 RED/GREEN numbers.
- Do not touch helpGate.ts, adapters, queryHandler, service.ts or retrieval.
- Execution-review: re-run AC-17 RED/GREEN itself; probe at least 10 fresh held-out "Monday, <unknown word> ..." inputs (must be byte-identical) and 5 fresh second-person-opener inputs (must fire). Any new counterexample in a KEEP shape that the cleaner strips is a class failure of this plan, not an instance to patch.
- Optional live smoke (orchestrator, non-blocking, not an AC): one real-model ask of the operator example and of "is the deploy on the 3rd, Monday?", answers recorded in the close file.

## Named risks

- **The operator's literal example is now guarded only by the prompt clause.** "Monday, can provide business rules...?" has no "you" and stays byte-identical by design (a "Monday, <verb> ..." shape is also a natural date-topic shape). The revised clause names that exact sentence as a name-call. If the ask log still shows weekday misreads on that shape, the next step is a prompt tweak or a new opener added to the allowlist -- never a date-word list.
- **Second-person openers could, rarely, front a date** ("Monday, can you make standup?"). The bot is the addressee of every message it receives, so "you" means the bot; accepted.
- **Retrieval still embeds the raw question** (unchanged from master; not part of this ticket).
- **Prompt tone drift**: the clause is interpretation-only; existing prompt-integrity corpus guards it.

## Deferred-follow-ups:
- Live-model check that the revised clause stops the weekday misread on "Monday, can provide business rules...?" -- file-when-triggered: the orchestrator's optional live smoke or the ask log shows a misread; then file an S ticket for a prompt/allowlist tweak.
- Retrieval-seam cleaning of name-calls -- none (no evidence recall suffers; file-when-triggered if it does).
- A bare-"Monday" colon arm or trailing arm -- none (decided NOT arms in B3; would need a new plan and plan-review).
