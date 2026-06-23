# 1066 — Citation / Answer Hygiene (slice 1)

## ELI5
Right now the bot always shows the top 5 documents it looked at, even when the
answer only really used 1 of them — and on "I couldn't find it" replies it still
shows 5 unrelated documents, which makes it look like it's citing them. This
change makes the bot show ONLY the documents it actually pointed at in the
answer (the `[N]` tags), show NOTHING when it cited nothing, lead with what it
DID find before mentioning gaps, and stop a weird-looking document title (one
with stray `**` markdown) from breaking the Slack layout.

## Execution model
subagent (knob-A = `delegate`). Rationale: the work spans 2 source files + 2
test files (>10 LOC, above trivial-skip) and is fully briefable as one coherent
surface, so it is handed to a single fresh executor subagent; reviewed by a
stateless plan-reviewer before and a stateless execution-reviewer after. Not
inline (no live-session coupling), not parallel (one disjoint surface).

## Scope
- `src/llm/generate.ts` — cited-only citation filtering + system-prompt reorder.
- `src/slack/formatter.ts` — sanitize source/heading text against stray markdown.
- `tests/generate.test.ts`, `tests/slack-formatter.test.ts` — new + updated unit tests.

In-scope only; the following are intentionally untouched (SCOPE GUARD): retrieval,
the LLM model choice, admin commands, `src/slack/adapter.ts`,
`src/slack/commands.ts` (concurrent rename PR owns those two files).

## cairn
cairn: ran `node skills/cairn/bin/cairn-find.mjs "citation"` / `"slack format"` —
no monday-bot-specific hits; nearest applicable lesson is the parent-CLAUDE
"eyeball the specific instance" + both-ends-testable discipline, applied here as
pure-helper unit tests on the exact filter behavior.

## Fix 1 — Cited-only source list (`generate.ts`)
After the answer TEXT exists (BOTH the live-LLM path AND the `offlineAnswer`
path), parse the set of `[N]` markers that actually appear in the answer and
return ONLY those citations, KEEPING their original numbers (cite `[2]` and
`[4]` → return citations numbered 2 and 4; never renumber to 1,2). No `[N]`
markers (refusals / NO_CONTEXT_ANSWER) → empty citations array.

- Add an exported pure helper `selectCitedCitations(answer, citations)` so the
  filter is directly both-ends unit-testable (the anthropic stub only ever
  cites `[1]`, so the [2]/[4] case can't be reached through `generateAnswer`).
- Apply it in the live path (`{ answer: text, citations: selectCitedCitations(text, buildCitations(chunks)) }`)
  and in `offlineAnswer` (`citations: selectCitedCitations(answer, buildCitations(chunks))`).
- The empty-chunks short-circuit and the non-text-response branch already return
  `citations: []` — leave them.

### Known existing-test interaction (intended behavior change)
`generate.test.ts` "chunks produce an answer plus a citations array keyed by
source" passes 2 chunks through the LIVE path; the stub answer cites only `[1]`,
so under cited-only filtering the result is exactly 1 citation (number 1), not 2.
This existing test is UPDATED to assert the new cited-only contract (length 1,
only citation 1). This is the intended fix, not a regression.

## Fix 2 — Lead-with-found framing (`generate.ts`, prompt-only)
Reorder `SYSTEM_PROMPT` so the model LEADS with what it found in context and
cites it, and only notes any remaining gap AFTERWARD — while KEEPING the
existing honesty rule ("if the context contains no relevant info, say you
couldn't find it"). Prompt text only; no logic change. No test asserts the exact
prompt string (verified), so this breaks nothing.

## Fix 3 — Sanitize source/heading markdown (`formatter.ts`)
A source/heading containing literal Slack mrkdwn (e.g. stray `**`) breaks the
context-block layout. Add a small `sanitizeTitle(s)` that (a) escapes Slack's
required HTML chars `& < >` and (b) strips the emphasis/code chars `* ~ `` `
that have no legitimate place in a filename/heading and were the culprit. Leave
`_` intact (legitimate in filenames; only italicizes in matched pairs). Apply to
`c.source` and `c.heading` where the context line is built.

## Binary AC
1. `npm run build` exits 0 (tsc clean) in the worktree.
2. `npm test` exits 0 with ALL specs green, INCLUDING:
   - new: answer `"…foo [2] … bar [4]"` over 5 chunks → exactly citations `[2],[4]`.
   - new: answer with NO `[N]` markers → `[]`.
   - new: the `NO_CONTEXT_ANSWER` sentinel → `[]`.
   - new: a source title containing `**` renders with no literal `**` in the
     context-block element text.
   - updated: the live-path 2-chunk test asserts cited-only (1 citation).
3. `git grep` of the diff contains no regulated employer-brand token; the repo
   privacy denylist gate passes on the PR.

## Roles
- planner: inline-skip (orchestrator) — the brief fully decomposes the work
  (exact files, exact both-ends behavior, exact new tests); there is no
  architectural discovery, only mechanical transcription of an already-specified
  contract. Specific reason recorded for the gate.
- plan-review: stateless write-capable subagent.
- executor: stateless write-capable subagent.
- execution-review: stateless write-capable subagent.

## Deferred-follow-ups:
- This is slice 1 of the #1066 UAT polish; the remaining UAT polish items (the
  low-pri lowercase-"couldn't" refusal variance, any broader answer-quality
  tuning) are NOT addressed here. → file a follow-up slice only if the live
  re-UAT after this deploy still shows them; the prompt reorder in Fix 2 may
  already resolve the lowercase variance. No load-bearing work is being silently
  dropped — slice 1's three fixes are the full committed scope.

## Review (plan)
Decision: PASS — all three fixes verified implementable against source; both
citation paths (live + offline) covered with original-number-preserving filter,
exported pure helper is the correct both-ends approach (stub only cites [1]), no
test asserts the system prompt text (grep-verified) so Fix 2 is safe, sanitize
correctly strips `* ~ \`` while leaving the `*[N]*` bold wrapper intact, scope
guard on adapter.ts/commands.ts confirmed, and Binary AC is observable from
outside the diff. No required changes. Full review:
.ai-workspace/reviews/1066-citation-plan-review.md

## Review (execution)
Decision: PASS — build exit 0; 22 suites / 183 tests green; privacy-clean;
scope guard holds (adapter.ts/commands.ts untouched). All three fixes verified
in code (cited-only filter at both live+offline paths with original-number
preservation + defensive guard; prompt reorder keeps honesty/never-cite/concise
rules; sanitizeTitle escapes &<> then strips *~` while preserving the `*[N]*`
wrapper and `_`). The two AC-03 e2e assertion changes are a FAITHFUL, minimal
re-expression of the parser-agnostic-parity intent at the index layer
(documentCount) — necessary because cited-only filtering retires the old
all-sources-cited proof vehicle — not an improper weakening. Full review:
.ai-workspace/reviews/1066-citation-execution-review.md
