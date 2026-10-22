# 3323 — execution review (the bot knows its own name)

PR: ziyilam3999/monday-bot#273 · branch 3323-own-name · reviewed diff: origin/master...HEAD (3b65a53)
Reviewer seat: execution-review (fresh, adversarial; did not author plan or code)

## Review

Decision: NEEDS-WORK

The wiring, the single source of truth, the prompt clause and the test hygiene are all correct. The cleaner breaks the brief's own must-not-fire class, though. A sentence that opens with a list of weekdays, or that puts a time-of-day word before "Monday", loses its real date before the model sees it. On origin/master that text reaches the model intact, so this is a regression on real weekday questions. The fix is small and stays inside the one file.

### What I verified myself (not from executor claims)

- RED: I copied the new and extended test files onto a pristine `git archive origin/master` scratch tree. Both suites FAIL there (the vocative suite cannot import `stripNameCall`; prompt-integrity has 3 failed). GREEN at head.
- At head: `npx tsc --noEmit` exit 0; full `npx jest` 70/70 suites, 805/805 tests. The earlier single failure the orchestrator saw did NOT reproduce in my run. I found no cause, so treat it as unexplained flake. It is not tied to this diff: the new tests are pure string functions.
- PR CI: build (ubuntu-latest, 20) pass; denylist pass.
- Wiring (AC-9): `stripNameCall` is called in exactly one place, where the `Question:` line is built inside `generateAnswer`. `question` has no other use in that function. Adapters, helpGate, queryHandler, service.ts, retrieval and the ask log are untouched by the diff. Upstream parity holds by construction, and the existing corpus is green without edits.
- AC-8: `BOT_NAME_TOKENS` (and `GREETING_LEXICON`) are imported from src/telegram/helpGate.ts. No second list exists. The test is driven by the constant.
- AC-7: the clause is appended after the existing last sentence. No existing clause is reworded, and every existing prompt-integrity assertion stays green. The clause covers interpretation only (no persona or signing instruction), so grounding, citation and abstain rules are not weakened.
- Size-S: one code file (src/llm/generate.ts) plus jest unit tests, no new smoke. That fits S.
- Named-risk notes: `named-risk-notes.mjs list --task 3323` printed `NO-NOTES 3323`, so there is nothing to disposition.

### Held-out probes run against the real function (scratch test, since moved to quarantine)

Kept byte-identical (correct): "Monday's release notes?", "on Monday, what shipped?", "every Monday we deploy, right?", "Monday morning standup?", "is it due Friday or Monday?", "standups are Tuesday, Thursday, and Monday", an "email <address that starts with monday and an at-sign> about leave" probe.
Mixed case (AC-6): "Monday, what is due on Monday?" → "what is due on Monday?" (correct).

### Findings

1. **MAJOR — leading arm strips a real weekday that opens a list or a date phrase.** The brief names this exact case as must-not-fire.
   - "Monday, Tuesday and Wednesday: who is on call?" → "Tuesday and Wednesday: who is on call?"
   - "Monday, Wednesday, Friday deploys - what is the schedule?" → "Wednesday, Friday deploys - what is the schedule?"
   - "Monday, May 5th: what is due?" → "May 5th: what is due?"; "Monday, the 3rd - is the office open?" → "the 3rd - is the office open?"
   A comma alone does not mark a vocative: "Monday," followed by another weekday, a month, a number or "the" is a date. Suggested fix: the leading arm must NOT fire when the next word token is a weekday or month name, starts with a digit, or is "the". Add these four cases as must-not-fire tests.

2. **MAJOR — the greeting-adjacent arm also fires on time-of-day words.** `GREETING_LEXICON` includes "good", "morning", "afternoon" and "evening", so:
   - "morning Monday standup?" → "morning standup?"
   - "Afternoon monday meeting cancelled?" → "Afternoon meeting cancelled?"
   - "evening Monday shift - who is on?" → "evening shift - who is on?"
   In these sentences "Monday" is a date, not a name-call. Borrowing the greeting gate's lexicon is fine for the card gate, but at this seam the words that double as times of day turn into a date-eater. Suggested fix: limit this arm to true salutations by leaving out good/morning/afternoon/evening when you match here, and add must-not-fire tests for them.

3. **MINOR — when any arm fires, all whitespace in the question collapses.** `kept.join(" ")` turns newlines and runs of spaces into single spaces: "Monday,\nwhat about leave?" → "what about leave?". This is harmless for one-line asks. A multi-line question (pasted error text, a list) loses its line structure in what the model sees. Optional fix: remove only the matched tokens from the original string. If not fixed, document it.

4. **MINOR — trailing arm eats a weekday that ends a list** ("which days are deploy days: Tuesday, Monday?" → "...: Tuesday"). The plan already accepts this as a named risk. If you fix item 1, apply the same weekday-neighbour guard here (do not fire when the token before the comma is a weekday name).

5. **INFO — conservative misses, acceptable as designed:** "Monday: …", "Monday! …", "Monday… …" and "@Monday_Bot: …" are not stripped (colon and exclamation do not count as announcing punctuation, and ':' is not in the mention-tail strip set). The prompt clause covers these. No action needed.

6. **INFO — ledger:** `3role-ledger.mjs check --task 3323` currently reports plan-review missing and the plan unresolvable at the refs it consulted (origin/3323, origin/master). This is orchestrator-side bookkeeping, not a code defect, but it must be resolved before ship-tail.

### What would flip this to PASS

Fix findings 1 and 2, each with must-not-fire tests that use the probe sentences above. Finding 4 is optional and can share the guard from finding 1. Everything else in the diff can stay as is.

## Review round 2

Reviewed head: 377e57c (fix commit 62a4f06, close-file section 4b67148). Delta reviewed: `git diff 3b65a53 377e57c -- src tests`, plus the plan amendment (B3/AC-5/AC-11) and the executor's `## Fix cycle 1` section.
Reviewer seat: execution-review, round 2 (delta review of fix cycle 1).

Decision: NEEDS-WORK

The fix cycle closes every probe sentence from round 1, and nothing older was weakened. But finding 1's class is only partly closed. The date-word guard knows full weekday and month names, digits, ordinal words and "the". It does not know abbreviations ("Tue", "Wed", "Jan", "Sept"), plural weekdays, or plain time and day words ("tomorrow", "morning", "noon"). The trailing arm also still eats a weekday that clarifies a date given just before it ("on May 5th, Monday?"). In every one of these cases the bot's own reading is "Monday is a date", and the cleaner deletes it. On origin/master that text reaches the model intact, so these are still regressions on real weekday asks. The fix is the same small, one-file guard, widened.

### What I re-ran myself

- RED at pre-fix: I extracted `git archive 3b65a53` into a scratch tree and dropped the head `tests/generate.vocative.test.ts` into it. `npx jest tests/generate.vocative.test.ts` exits 1 with 17 failed and 36 passed. The 17 failures are exactly the new fix-cycle-1 arms: 7 leading date-phrase, 4 time-of-day, 1 trailing day-list, 4 whitespace, 1 oversized.
- GREEN at head (worktree, 377e57c): `npx tsc --noEmit` exits 0. Full `npx jest`: 70/70 suites, 826/826 tests, exit 0 (no env override; ANTHROPIC_MODEL is unset in my shell).
- PR CI at head: build (ubuntu-latest, 20) pass; denylist pass.
- Nothing older weakened: the test-file diff since 3b65a53 is a pure append (hunk `@@ -175,3 +175,101 @@`). No existing assertion is edited or deleted, and prompt-integrity is untouched. The must-fire arms (AC-1..4, AC-6, compose, greetings) still produce exactly the same output as in round 1 (see probes below).
- Named-risk notes: `named-risk-notes.mjs list --task 3323` prints `NO-NOTES 3323`.

### Probes against the real head `stripNameCall` (scratch test in a /tmp archive of 377e57c; not committed)

Round-1 probes are all fixed. Each of these is now UNCHANGED: "Monday, Tuesday and Wednesday: who is on call?", "Monday, Wednesday, Friday deploys - what is the schedule?", "Monday, May 5th: what is due?", "Monday, the 3rd - is the office open?", "morning Monday standup?", "Afternoon monday meeting cancelled?", "evening Monday shift - who is on?", "which days are deploy days: Tuesday, Monday?". Also "Monday,\nwhat about leave?" → "what about leave?" with the newline structure kept.
Round-1 keep set: still UNCHANGED.
Must-fire: still fires. "Monday, can provide business rules…" → "can provide business rules…"; "Monday, what is due on Monday?" → "what is due on Monday?"; "hey Monday, can you…" → "hey, can you…"; "can you help, Monday?" → "can you help"; the @-mention case → "hey what is due on Monday?".

New counterexamples that still eat a real date (each is a regression vs origin/master, where the text passes intact):
- "Monday, Tue and Wed: who is on call?" → "Tue and Wed: who is on call?"
- "Monday, Jan 5th: what is due?" → "Jan 5th: what is due?"
- "Monday, Sept 3 - office open?" → "Sept 3 - office open?"
- "Monday, Mondays and Fridays are deploy days?" → "Mondays and Fridays are deploy days?"
- "Monday, tomorrow or Friday - which is the deadline?" → "tomorrow or Friday - which is the deadline?"
- "Monday, morning shift - who is on?" → "morning shift - who is on?"
- "Monday, noon - is the deploy window open?" → "noon - is the deploy window open?"
- "Monday, next week, who is on call?" → "next week, who is on call?"; "Monday, at 9am, is standup on?" → "at 9am, is standup on?"
- trailing: "the launch is on May 5th, Monday?" → "the launch is on May 5th"; "is the deploy on the 3rd, Monday?" → "is the deploy on the 3rd"; "standup moved to 9am, Monday?" → "standup moved to 9am"; "deploy days are Tue, Monday?" → "deploy days are Tue"

Conservative misses (fine by doctrine, so the prompt clause guards these): "Monday, may I see the refund policy?" and "Monday, the refund policy - what is it?" are UNCHANGED, and so is "good morning Monday, what is due?" (the plan names this as a carried risk).

### Round-1 findings: status

1. MAJOR (leading arm eats a date list or date phrase): PARTIAL. Every named shape is closed and RED→GREEN-proven. The same class is still open through abbreviations, plurals and time/day words, and is carried as R2-1 below.
2. MAJOR (time-of-day words arm the greeting arm): CLOSED. `SALUTATIONS` = `GREETING_LEXICON` minus good/morning/afternoon/evening, at this seam only (still borrowed, not copied, so B2 holds; helpGate is untouched). The 4 time-of-day fixtures are RED at 3b65a53 and GREEN at head, and "night Monday deploy?" and "evening, Monday, who is on?" are UNCHANGED.
3. MINOR (whitespace collapse): CLOSED. The rebuild splices from the original string using token spans, and the 4 whitespace fixtures are RED→GREEN. One note: the whitespace that FOLLOWED a removed token collapses to one space ("hey Monday,\nsummarise" → "hey, summarise"). That matches AC-11's "whitespace that announced them" wording, so it is not a finding.
4. MINOR (trailing arm eats a weekday that closes a list): CLOSED for full weekday names ("Tuesday, Monday?" fixture is RED→GREEN). Abbreviated and date-phrase neighbours are carried as R2-2.
5. INFO (conservative misses): unchanged, and still acceptable.
6. INFO (ledger): CLOSED for planner and plan-review. `3role-ledger.mjs check --session … --task 3323` now blocks only on execution-review, because the round-1 NEEDS-WORK row is still in force. That is expected until this seat records a PASS.

### Round-2 findings

R2-1. MAJOR: the leading-arm date guard misses abbreviated, plural and time/day date words. Same class as round-1 finding 1, and the same regression vs origin/master; see the counterexamples above. Fix, in `isDatePhraseWord` only:
   - add weekday abbreviations: mon, tue, tues, wed, weds, thu, thur, thurs, fri, sat, sun
   - add month abbreviations: jan, feb, mar, apr, jun, jul, aug, sep, sept, oct, nov, dec
   - add plural weekdays (a weekday word with a trailing "s")
   - add the day and time words: today, tomorrow, yesterday, tonight, morning, afternoon, evening, night, noon, midnight
   - optional: next, this, last, at
   A wider guard costs only conservative misses (ambiguity → keep), which the doctrine accepts. Add must-not-fire fixtures for at least the "Tue and Wed", "Jan 5th", "tomorrow or Friday" and "morning shift" probes.

R2-2. MINOR: the trailing arm ignores date phrases before the announcing comma. "the launch is on May 5th, Monday?" → "the launch is on May 5th", and likewise "on the 3rd, Monday?", "to 9am, Monday?" and "Tue, Monday?". The guard checks only `WEEKDAY_WORDS` on the token before the comma. Mirror the leading arm: do not fire when `isDatePhraseWord(rawTokens[n - 2])` is true (it already folds trailing punctuation, so "5th," → "5th" is digit-leading). The plan's named risk calls a trailing date "an unnatural shape", but "on May 5th, Monday?" is a natural confirmation question. Add the 4 probes above as must-not-fire fixtures.

R2-3. INFO: cosmetic damage in the fix commit. The `isNameToken` doc comment changed from `"_"-vs-"-"` to `"_"-vs"-"` (a hyphen was lost), and the blank line before the #3323 doc block was removed. Restore both if you touch the file again.

R2-4. INFO: the 4096-character fail-closed bound is measured in UTF-16 code units (`question.length`). That is fine for Telegram. A longer Slack question falls back to today's master behaviour (uncleaned, prompt clause only), which is safe. No action needed.

### What would flip this to PASS

Fix R2-1 and R2-2 inside `src/llm/generate.ts`, each with must-not-fire fixtures that use the probe sentences above, and leave every existing fixture green. R2-3 is optional. Nothing else needs to change.
