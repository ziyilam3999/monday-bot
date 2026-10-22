# 3323 execution-review, round 4 (re-plan build)

Task: #3323 · PR: ziyilam3999/monday-bot#273 · Reviewed head: a56937f22566575ce3fe82f04ddca738f24b5e95
Plan (contract): .ai-workspace/plans/2026-10-23-3323-own-name-replan.md (plan-review round 4 PASS)
Executor close: .ai-workspace/reviews/3323-executor-close.md (read, not trusted; every claim re-run below)
Reviewer seat: execution-review (Claude). I did not author the plan, the plan review, or the code.

Decision: PASS

The build does what the re-plan asks. The cleaner now keeps the text unchanged unless the sentence shape proves it is a call to the bot. It strips nothing on an unknown word, and the date word lists are gone. I re-ran RED and GREEN myself. All 17 Binary AC hold. The only open item is the live smoke (note 6), which could not run because the API returned HTTP 429. It is an orchestrator step before ship-tail, not a code defect.

## Re-run evidence

- GREEN at a56937f: `ANTHROPIC_MODEL= npm test` -> Test Suites 70 passed, Tests 917 passed, exit 0. `npx tsc --noEmit` exit 0. `npm run build` exit 0. Working tree clean afterwards.
- RED at f4122cc: `git archive f4122cc` extracted into the worktree's ignored tmp/ dir (node_modules symlinked; branch not touched). I copied in the new vocative test, the prompt-integrity test and the fixture, then ran `npx jest tests/generate.vocative.test.ts tests/generate.prompt-integrity.test.ts` -> 65 failed, 87 passed, 152 total. That matches the executor's numbers. The failing set includes the AC-4 colon entries ("Monday: who is on call?", "Monday: standup cancelled?", "Monday: where do I find the onboarding checklist"), the AC-4 greeting entries ("hi Monday, Tuesday and Wednesday: who is on call?", "hey Monday, May 5th is the launch?", "yo Monday standup cancelled?"), the AC-6 entries ("Monday, can provide business rules ...", "MONDAY, what about the refund policy?", "HELLO MONDAY ...") and every AC-7 entry ("Monday, zorblax deploys ...", "hey Monday, payroll ...").
- PR checks: build (ubuntu-latest, 20) SUCCESS and denylist SUCCESS. PR head = a56937f. MERGEABLE.
- Corpus presence: a script parsed every quoted string in the plan's AC-2..AC-8 lines and every `in -> out` pair in AC-9..AC-11, then looked each one up in tests/fixtures/3323-vocative-corpus.json. Result: 0 missing (AC-2 8/8, AC-3 13/13, AC-4 26/26, AC-5 15/15, AC-6 8/8, AC-7 8/8 named, AC-8 13/13) and 0 wrong outputs (AC-9 5/5, AC-10 5/5, AC-11 pairs exact). The corpus has 104 keep entries (no duplicates) and 20 fire entries.

## Binary AC

| AC | Verdict | Evidence (re-run by this seat) |
|---|---|---|
| AC-1 | MET | The fixture parses. keep=104 and fire=20 are both non-empty. The suite runs one `it` per entry, plus property tests. |
| AC-2 | MET | All 8 present. Green at head. |
| AC-3 | MET | All 13 present. Green. |
| AC-4 | MET | All 26 present (greeting, colon, word-list gaps, trailing). Green. |
| AC-5 | MET | All 15 present. Green. |
| AC-6 | MET | All 8 present. Green. |
| AC-7 | MET | Exactly 12 real anti-denylist entries: zorblax, quuxday, quarterly review, payroll, holiday party, sprint demo, hi+zorblax, hey+payroll, frobnitz, retro notes, hello+onboarding checklist, wibble. All are red at f4122cc and green at head. See finding 3 for the count test. |
| AC-8 | MET | All named families present (we-opener, wh-body, imperative without "me", modal without "you", no space, full-width comma, bare name x3, plural and possessive, mid-sentence monday-bot, @monday_fan). Green. |
| AC-9 | MET | 5/5 exact. |
| AC-10 | MET | 5/5 exact, including the trailing "?" survival. |
| AC-11 | MET | would-you, hello salutation, show/give/help me, all-caps, Monday_Bot, multi-line. All exact. |
| AC-12 | MET | `command grep -c '"monday-bot"' src/llm/generate.ts` = 0. The suite loops over the imported BOT_NAME_TOKENS. No second name list exists: the ambiguous/unambiguous split is derived from the constant. |
| AC-13 | MET | The subsequence and non-empty checks are asserted over the whole fire array. See finding 1 for a shape outside the fire array. |
| AC-14 | MET | The suite asserts none of the 6 markers appear in `stripNameCall.toString()`. I also grepped the whole cleaner region (generate.ts lines 36-285, including the unexported helpers) for sept/tomorrow/midnight/ordinal/tue/jan: zero hits. isDatePhraseWord and the 5 date sets are gone from the file. |
| AC-15 | MET | (a) to (d) are pinned, with (c) as fixed substrings and (d) as `/never a date/i`. The diff of tests/generate.prompt-integrity.test.ts against merge-base dd870f2 adds 25 lines and changes no existing line, so the master-era assertions are unedited and green. |
| AC-16 | MET | `command grep -c 'stripNameCall(' src/llm/generate.ts` = 2 (line 200 is the definition, line 726 the one call in generateAnswer). The bound test passes: 4097 characters come back identical, 4096 characters are cleaned. |
| AC-17 | MET | RED is 65/152 at f4122cc, failing set as listed above. GREEN: full suite, tsc and build all exit 0. The new tests build no model client: the vocative suite imports only stripNameCall, helpGate, fs and path. |

Scope (B1): `git diff --name-only dd870f2..HEAD`, ignoring .ai-workspace/, lists only src/llm/generate.ts, the new fixture, tests/generate.vocative.test.ts and tests/generate.prompt-integrity.test.ts. helpGate.ts, adapters, queryHandler, service.ts and retrieval are untouched. B5: no env var, config or kill switch was added.

## Held-out probes (the plan's execution-review duty)

I ran a scratch jest file in the ignored tmp/ dir against the head cleaner.

- **Fresh "Monday, <unknown word> ..." inputs, all byte-identical (13 of 13):** glimmerfax rollout, snorkel budget, vendor invoices, offsite agenda, kickoff, blarghus sync, fortnightly retro, half-day, bank holiday, Q3 planning, and the salutation forms "hey Monday, snorkel budget - approved?" and "yo Monday, kickoff - who attends?".
- **Weekday and date shapes from the brief, all byte-identical:** "Monday, 3 pm works?", "Monday, the deadline is noon - right?", "Monday, 10:30 standup - still on?", "Monday,, tuesday and wednesday off?", "on Monday, can you cover the shift?", "next Monday, can you cover?", "by Monday, please send the report", "Monday 3pm, can you join?", "Monday's deploy, can you check it?", "Monday is a holiday, can you confirm?".
- **Near-miss openers, all byte-identical:** "Monday, can I take leave?", "Monday, do we have standup?", "Monday, are we open?", "Monday, will the office be open?", "Monday, can't make it - who covers?", "Monday, you know the drill ...", "Monday, if possible, can you check?". Also the separator variants "Monday; ...", "Monday - ...", "Monday. ...", "Monday! ...", the no-punctuation form "monday can you help?", the excluded time-of-day salutations "good morning Monday, ..." and "thanks Monday, ...", and "Monday: can you help?".
- **Fresh second-person openers, all fire, deletion-only (7 of 7):** "Monday, could you list ...", "Monday, will you check ...", "hi Monday, would you summarise ...", "Monday, tell me ...", "Monday, please explain ...", "yo Monday, show me ...", and "Monday, can you check who is on call Monday?", where the real-date Monday at the end survives.

No KEEP-shape counterexample was found, so there is no class failure.

## Findings (all non-blocking)

1. **One non-deletion edit, outside the fire corpus (cosmetic).** "hey monday-bot: who is on call?" becomes "hey, who is on call?". When a salutation is followed by an unambiguous name, the cleaner adds a comma after the salutation even if the name was announced by a colon. That inserts a "," that was not in the input; the subsequence check fails for this input. AC-13 only covers fire entries, so the AC holds. The meaning is unchanged, no date is involved and only the bot's unambiguous name is removed. I accept it. If touched later, add the comma only when the announcer was a comma. That is the AC-9 move, and it is deletion-only.
2. **Residual "please" memo risk: accepted, inside the plan's scope.** "Monday, please list the attendees - is that the rule?" becomes "please list the attendees - is that the rule?". The same happens with please+confirm/check/share/find. This does not break the must-not-change contract, for three reasons. (a) The plan's B3 arm A names "please" as an addressing opener with no verb limit; the executor's verb allowlist is stricter than the plan. (b) The must-not-change contract is the keep corpus plus "an unknown word never causes a strip". "list" is an allowlisted addressing verb, not an unknown word, and this is not one of B3's "Explicitly NOT arms" shapes. (c) The plan's named risk "second-person openers could, rarely, front a date ... accepted" covers this class. "Monday, should you miss standup, ..." (conditional inversion) and "Monday, can you make standup?" also lose "Monday" under that same accepted risk. The model still gets the prompt clause. Follow-up: file-when-triggered. If the ask log shows a please-memo date being lost, file an S ticket to narrow the please-verb list. Never answer it with a date-word list.
3. **The AC-7 count test is loose (test-quality nit).** The suite counts keep entries matching `/^(hi |hey |hello )?Monday, [a-z]+ /`. That regex matches 41 entries, including calendar words ("the 3rd", "tomorrow", "noon", "through") and openers ("can we", "list"). The `>= 12` check would pass even if the real anti-denylist entries were removed. AC-7 still holds, because the corpus contains exactly 12 real entries (listed above) and each is asserted byte-identical by its own test. A tighter count would list the 12 by name.
4. **"@monday" used as a date shorthand loses it (plan-sanctioned).** "standup is @monday at 9?" becomes "standup is at 9?". B2 classifies "@monday" as UNAMBIGUOUS and arm U strips any @-mention of a name token anywhere. This follows the plan exactly, and in chat apps "@monday" is the mention handle. I record it as an observation, not a defect.
5. **AC-14 reach.** The `toString()` check covers only the body of stripNameCall, not the unexported helpers (plan-review note 8). My grep of the whole cleaner region found zero markers, so the property holds today. A future helper edit would not be caught by the suite. Non-blocking.
6. **Live smoke NOT MEASURED (plan-review note 6, Rule 18). This is an orchestrator pre-ship step.** The operator's literal example ("Monday, can provide business rules for dispute resolution?") is byte-identical by design. Only the SYSTEM_PROMPT clause protects it, and that clause's effect on a real model is unproven. The executor's attempt got HTTP 429 twice. I did not try it, per the brief. Before ship-tail, the orchestrator must run one real-model ask of the operator example and one of "is the deploy on the 3rd, Monday?", and record both answers in the close file.

## Plan-review notes 1-8: disposition

- Note 1 (AC-12 vs the prompt literal): closed. The prompt escapes its quotes, the doc comment was reworded, and the grep returns 0.
- Note 2 (B3 wording vs AC-9): closed. AC-9 behaviour was built ("hey Monday, can" -> "hey, can"), and the close file corrects the B3 sentence.
- Note 3 (AC-15(c)/(d) binary): closed. Fixed substrings are used, plus a case-insensitive `/never a date/i` check and the "never something to answer about" phrase.
- Note 4 (salutation set): closed. SALUTATIONS = GREETING_LEXICON minus good/morning/afternoon/evening, and a regression test covers the four time-of-day words.
- Note 5 (please opener): see the DISPOSITION line below and finding 2.
- Note 6 (live smoke): open. NOT MEASURED, handed to the orchestrator as a pre-ship step (finding 6).
- Note 7 (AC-16 brittleness): closed. No comment uses the call token, the grep count is 2, and the suite counts non-comment call lines (1).
- Note 8 (AC-14 scope): closed in substance. The date sets and the guard are deleted, and the helpers hold no markers (finding 5).

## Carried named-risk notes

`node hooks/named-risk-notes.mjs list --task 3323` (run from the monday-bot worktree) printed one note, 3323-please-opener-date.

DISPOSITION 3323-please-opener-date addressed: stripNameCall('Monday, please submit timesheets - is that the rule?') now returns the input byte-identical (keep corpus entry plus a named test, green at a56937f). The residual allowlisted-verb form ("please list ...") is accepted in scope per finding 2.

## Monotonicity (#1590)

The stronger claim is "byte-identical" (keep), and it is the default return path (`remove.size === 0` returns the input). The arms only add indices to a `remove` set that starts empty. Nothing removes an index from the set, and no arm can be reached through an unknown word. Arm A needs a closed-set opener, and arm U needs a token from BOT_NAME_TOKENS. The "remove everything" case also falls back to the input. The weaker claim cannot erase the stronger one.

override env vars used: none.
