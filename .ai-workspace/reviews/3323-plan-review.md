# 3323 plan-review — the bot knows its own name (round 1, full adversarial)

Reviewed: `.ai-workspace/plans/2026-10-22-3323-own-name.md` as written, against branch head
4b67148 (executor fix cycle 1 already landed; PR ziyilam3999/monday-bot#273). Premises verified
by execution on this worktree: direct probes of the exported `stripNameCall` (src/llm/generate.ts:181),
full `npx jest` (826 tests) and `npm run typecheck` at head, export-absence on origin/master,
and inspection of `BOT_NAME_TOKENS` / `GREETING_LEXICON` in src/telegram/helpGate.ts.

## Review

DISPATCH-NONCE:OR-NONCE-56a3eb3ce672f55e

Decision: NEEDS-WORK

1. **BLOCKER (major) — B3's arms as specified destroy real weekday dates, and the AC-5 corpus
   cannot observe it.** Verified by execution and by reading the plan's own matcher spec against
   helpGate's real constants:
   - Leading arm (B3): "first token normalizes to a name token AND is comma-announced → remove".
     Both `"Monday, Tuesday and Wednesday"` and `"Monday, May 5th"` satisfy that rule exactly
     (first token `Monday,` is a comma-announced name token), so per the plan as written the
     weekday heading a day LIST or a calendar DATE is removed and the date meaning is destroyed.
     This is not a constructed stub — it is the ticket's own protected class (real weekday
     questions keep "Monday" as a date) and it broke in real execution (e671c9b).
   - Greeting-adjacent arm (B3): the plan borrows GREETING_LEXICON (helpGate.ts:30–43), which
     contains `good`, `morning`, `afternoon`, `evening` — so `"morning Monday standup"` fires the
     arm per plan spec and the weekday is eaten.
   - AC-5's must-not-fire corpus (four arms) and the Tests table contain ZERO weekday-list,
     calendar-date, or time-of-day-word arms — the three classes exactly where the plan-specified
     matcher misfires. An executor following this plan has no observable AC that fails when they
     destroy these dates.
   The shipped head is green on all these shapes ONLY because 62a4f06 added `WEEKDAY_WORDS`,
     `TIME_OF_DAY_WORDS`, month/date-phrase detection, and `SALUTATIONS` (lexicon minus
     time-of-day words) — guards no boundary in the plan authorizes, specifies, or names. The
     plan no longer describes the shipped matcher; re-executing from this plan would reintroduce
     the bug. Remedy (docs-only, no code change): fold the fix-cycle-1 contract into B3 (the
     three guard classes, comma-announced-leading must also not be followed by a date-word,
     whitespace-preserving rebuild) and extend AC-5 + the Tests table with must-not-fire arms for
     weekday lists ("Monday, Tuesday and Wednesday"), calendar dates ("Monday, May 5th"), and
     time-of-day words ("morning Monday standup").

2. **Minor — the plan was not amended after fix cycle 1, which is what made finding 1 possible.**
   The executor's close note (4b67148) documents five contract items that exist only in the code
   and the executor's note. Per the round-scoping doctrine (#2416), the plan is the durable
   artifact future rounds re-execute from; the hardened contract must live in the plan, not in a
   close-note appendix. Same remedy as finding 1.

3. **Verified good (no action)** — premises I confirmed by execution, for the record:
   - One source of truth holds: `stripNameCall` imports `BOT_NAME_TOKENS` (generate.ts:6), no
     second name list anywhere; the test drives coverage from the constant itself (AC-8 by
     construction, tests/generate.vocative.test.ts:151–163).
   - Upstream parity holds: `stripNameCall` is applied at exactly one seam (generate.ts:718,
     inside `generateAnswer`); the branch diff touches one code file + two test files; adapters,
     helpGate, service/ask log untouched (AC-9).
   - AC-7 identity clause present (generate.ts:40–44) with weekday-as-date preservation.
   - RED premise holds by construction: `stripNameCall` appears 0 times in
     origin/master:src/llm/generate.ts, so the new test file cannot even import at master.
   - Suite health at head: 826/826 jest green, typecheck green. (One local run showed a
     `generate.test.ts` model-name failure caused solely by this review session's own shell
     model env vars; clean when those are unset — environmental, not a branch defect.)
   - Size S is right: one seam, one code file, ~540 added lines total, no new knobs (B6 holds).

4. **NAMED-RISK NOTE (carry to execution-review, not a blocker)** — conservative false negatives
   remain by design: comma-less leading name-calls ("Monday can you help") and
   time-of-day-guarded shapes ("good morning Monday, what is due?" passes byte-identical at
   head, probed) are not cleaned; the prompt clause is the guard. Already named in the plan's
   Named risks; consistent with the ambiguity→keep doctrine; no AC arms requested.

## Review

DISPATCH-NONCE:OR-NONCE-fe0fb70ce363e357

Decision: PASS

Round 2 (scoped per #2416: re-adjudication of round 1's concrete counterexamples, executed premises, and real-corpus protection only). Plan reviewed at 830e723 (amended plan), verified against shipped head 830e723 with code frozen at 62a4f06 (diff 62a4f06..HEAD touches only plan/review docs).

1. **Round-1 finding 1 (BLOCKER) — CLOSED, verified by execution.** The B3 amendment folds all five fix-cycle-1 contract items into the plan (date-word guard on the leading arm: weekday/month/ordinal-word-or-digit-leading/"the"; true-salutation filter = GREETING_LEXICON minus good/morning/afternoon/evening; weekday-neighbour guard on the trailing arm; whitespace-preserving splice from the original string; >4096 fail-closed bound), and the amendment text matches the shipped code (WEEKDAY_WORDS/MONTH_WORDS/ORDINAL_WORDS/SALUTATIONS/MAX_CLEANABLE_LENGTH, src/llm/generate.ts:77–181). I re-ran round 1's concrete counterexamples as direct probes of the exported `stripNameCall` at head, using the EXACT strings from the round-1 finding and the AC-5 amendment — "Monday, Tuesday and Wednesday: who is on call?", "Monday, May 5th is the launch?", "Monday, the 3rd?", "morning Monday standup?", "good morning, is the deploy on Monday?", "Tuesday, Monday?" — all byte-identical, and the must-fire control ("Monday, can provide business rules for dispute resolution?") still strips. Re-executing from this plan now reproduces the guarded matcher; the plan no longer under-describes the shipped code.

2. **Round-1 finding 2 (minor) — CLOSED.** The plan carries a dated, append-only amendment header (2026-10-22): the original B3/AC-5/Tests-table text is retained verbatim with the hardened contract appended (B3 amendment, AC-5 amendment, AC-11 added), so earlier rounds stay readable and the durable artifact now owns the contract.

3. **Verified good (no action)** — premises re-confirmed by execution at head:
   - AC-5 amendment corpus: all five required must-not-fire strings are present verbatim in the plan AND as fixtures in tests/generate.vocative.test.ts; must-fire name-call cases number well over three across AC-1–AC-4/AC-6 and the Tests table (3 leading, 3 greeting-adjacent, 3 trailing, 3 @-mention in the checked-in fixtures).
   - RED premise: `stripNameCall` appears 0 times in origin/master:src/llm/generate.ts, so the new test file cannot import at master (RED by construction); at head the vocative suite, prompt-integrity phrase assertions (YOU ARE MONDAY BOT / CALL POSITION / KEEPS its date meaning, tests/generate.prompt-integrity.test.ts:94–109) and `npm run typecheck` are green.
   - Suite: 825/826 jest green; the single failure (generate.test.ts determinism model id) reproduces ONLY under this review session's model env vars and is green when those are unset for the child process — environmental, not a branch defect (same as round 1).
   - One source of truth (B2) and single-seam application (B1/B5) unchanged since round 1: code diff is one code file + two test files; helpGate, adapters, service untouched.

4. **NOTE (minor, non-blocking, no plan change requested per #2416)** — the checked-in fixtures paraphrase two amendment strings ("Monday, the 3rd - is the office open?" for "Monday, the 3rd?"; "which days are deploy days: Tuesday, Monday?" for "Tuesday, Monday?"). Both exact plan strings were probed separately at head and are byte-identical, so the discrepancy is informational only; do not add AC arms for it.

5. **NAMED-RISK NOTE (carried to execution-review, not a blocker)** — conservative false negatives remain by design: comma-less leading name-calls ("Monday can you help") and time-of-day-guarded shapes ("good morning Monday, what is due?") are not cleaned; the prompt clause is the guard. Already carried in the plan's Named risks section (round-1 finding 4); the actual diff at execution-review is where "did THIS implementation memorize?" is decidable.

Probe artifact: tmp/plan-review-r2-probe.test.ts (gitignored tmp/, uncommitted; run via `npx jest --testMatch "<rootDir>/tmp/**/*.test.ts"`).
