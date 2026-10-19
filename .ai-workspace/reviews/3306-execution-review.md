# 3306 execution review — Telegram pre-retrieval help-card gate

PR ziyilam3999/monday-bot#271 (draft) · branch 3306-help-cards · reviewed head f7dd9e6 · plan `.ai-workspace/plans/2026-10-19-3306-help-cards.md` (plan-review r2 PASS) · reviewer did not write this code.

## Review

Decision: PASS

### What I ran myself

| Check | Command (summary) | Result |
|---|---|---|
| Full suite at head | `npx jest` (plain) and `env -u ANTHROPIC_MODEL npx jest`, logs in my scratchpad | rc=0 both · 68 suites / 760 tests passed |
| Typecheck at head | `npm run typecheck` | rc=0 |
| RED at base, pure | pristine `git archive origin/master` copy + the 3 new test files | rc=1 · 3 suites failed (TS2307, gate/card/capabilities modules absent) |
| RED at base, behavioural | same pristine copy + the new PURE modules (capabilities, helpGate, helpCard) copied in, base `adapter.ts` / `commands.ts` kept | rc=1 · 14 failed / 68 passed. The 14 failures are exactly the must-fire arms: AC-1 x4, AC-3 x5, AC-5 x3, AC-9 card arm, AC-10 matching arm. Every must-not-fire arm (AC-2, AC-4, AC-6, AC-12) is green at base, so it pins today's behaviour |
| Slack `/help` byte-identity | base `helpCommand()` (pristine `commands.ts`) vs head `renderSlackHelp()` | `toBe` equal · rc=0 |
| Adversarial probe corpus | 68 inputs through `classifyHelpGate` + all 3 card arms through `buildHelpCard` (scratch test) | see findings; card has no registry token, no `/word` token, no `Sources` (case-sensitive) |
| Privacy | `git diff origin/master...HEAD --unified=0 \| command grep -E '^\+' \| command grep -c -iE 'get[- ]?[0-9]'` | 0 (positive control on a synthetic line prints 1) |
| Home path / email in added lines | same pipeline, pattern for home-path forms and mail addresses | 0 |
| PR checks | `gh pr checks 271` | build pass · denylist pass |

### AC verdicts (verified against the diff, not the executor close)

- AC-1 PASS: `/model`, `/start`, `/HELP`, `/model@monday_bot` each produce one card, 0 queries (red at base, green at head). I also probed `/Model.`, `/start@monday_bot`, `/help`, `/ask` (bare), `/jql` (bare): all card.
- AC-2 PASS: the 6 pass-through arms assert `queries === [text]` (byte-identical, exactly once) and `reply === renderTelegramReply(handleQuery(text))`. I also probed `/api/v1`, `/etc/hosts?`, `/ask@monday_bot how many days`, `/feedback-monday great bot`, `/123`, `/`: all take the doc path.
- AC-3 PASS: greeting arms, including `hello monday` and `hi @monday_bot`. I also probed `HELLO MONDAY`, `Hi Monday-Bot!`, `@monday_bot hi`, `@bot hi`, `hi?!`, `hi...`, `hi 👋`, `hi` + NBSP + `there`: all card.
- AC-4 PASS: greeting-prefixed questions take the doc path. I also probed `hi DEMO-673`, `hello monday what is DEMO-12`, `good morning, is the build green?`, `can monday bot tell me the leave policy`, `is monday a holiday`, `@monday_bot what is the vpn policy`: all take the doc path.
- AC-5 / AC-6 PASS: whole-message equality holds. `What can you do??`, `WHAT CAN YOU DO`, `HELP?`, `commands?` give a card. `help me find …`, `what can you do about crashes` take the doc path.
- AC-7 PASS: there is one shared module (`src/capabilities.ts`). The registry was moved verbatim and `helpCommand()` delegates to it. A golden test pins the output, and I checked it independently against the pristine base. The card embeds `SHARED_CAPABILITY_DESCRIPTION` and no registry token.
- AC-8 PASS: `capabilities.ts` imports nothing. `helpGate.ts` imports only `../capabilities`. `helpCard.ts` imports only `../capabilities` and the gate type. The adapter's card branch returns before `handleQuery`.
- AC-9 PASS: the card branch returns before `recordAsk`. The test proves 0 lines for a card and 1 for a doc ask.
- AC-10 PASS: each matching update sends exactly one message, and non-matching batches send 0 cards.
- AC-11 PASS: red at base (both the pure and the behavioural variants above) and green at head. jest and typecheck are both rc=0.
- AC-12 PASS: the gate runs AFTER the existing text-less and allow-list early returns, which are unchanged in the diff. The silence arms are green.
- Doc path byte-identity (brief item 3): on a non-match the adapter passes the same `text` variable to `handleQuery` as before. The diff only inserts a block in front of that call and changes no existing line of the doc path.

### Findings

1. MINOR (non-blocking, plan-sanctioned): a single-segment leading-slash word followed by a real question fires the card, because B4 treats any command-shaped unknown first token as a command whatever follows it. Probes: `/api what does this return`, `/health endpoint returns 500 why`, and a bare `/tmp` all produce a card, where today they get a doc answer. Multi-segment paths and URLs are handled correctly. This is exactly B4 as approved in plan-review r2 ("/model" etc. are unknown, so a card), so it is not a defect against the plan. Possible follow-up (S): limit P1 to a bare command, or to a command plus at most N tokens, if the ask log shows leading-slash questions.
2. INFO (named risk "one-word lexicon collisions", carried in the plan's Named risks section): the condition was checked and is NOT triggered. The shipped `GREETING_LEXICON`, `GREETING_FILLER` (+ `BOT_NAME_TOKENS`) and `HELP_PROBE_PHRASES` match the plan's B5/B6 lists one for one, with no growth. Observed one-word cards: `good`, `morning`, `evening`, `sup`, `commands`. `all good` also produces a card (filler + lexicon), which matches the spec. No ask-log evidence was consulted (none exists for a gate that has not shipped yet).
3. INFO (false misses outside the AC set, safe direction): `help please`, `what can u do`, a bare `@monday_bot`, and a lone emoji keep today's doc path. This is the ambiguity-goes-to-doc doctrine. No regression.
4. INFO (group chats): there is no chat-type branching, and the allow-list is unchanged. Today every allowed text message already gets a reply. The gate swaps a doc reply for one card message one-for-one and never adds a send, so a group sees no extra messages. Any `@suffix` is accepted (B4's named accepted edge). For example, if privacy mode is off, `/start@otherbot` in an allowed group would get our card instead of today's doc answer. The message count is the same.
5. INFO (pre-existing suite edit): `tests/telegram.test.ts` changed by 2 lines added and 2 removed (numstat). The brief forbids me from reading that file, so I did not inspect the lines. The executor discloses that 2 greeting-shaped fixtures were swapped for neutral doc questions, because the r2-approved AC-3 now routes them to the card. The numstat scope matches that disclosure, and the full suite is green.
6. INFO (Slack untouched): the only Slack change is in `src/slack/commands.ts`, which moves the registry out and delegates `helpCommand()`. `classifyMentionIntent` and the Slack adapter are not in the diff, and the base-vs-head golden is equal.

### Carried named-risk notes

`node hooks/named-risk-notes.mjs list --task 3306` printed `NO-NOTES 3306`. Nothing was registered for this task, so no DISPOSITION line is owed. The plan's in-file named risk is addressed in finding 2.

### Size

The ledger stamp is M (plan-review ran and was not waived). The diff matches M: three new src modules, two src edits and three new test suites.
