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
