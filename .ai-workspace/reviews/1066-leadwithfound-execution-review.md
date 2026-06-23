# 1066 — Lead-with-found (iteration 2) — Execution Review

Stateless execution review of `fix/1066-leadwithfound` @ HEAD `c773237`. I did NOT write this code.

## Goal recap
The bot was LEADING replies with "I couldn't find specific instructions…" even when it HAD
retrieved the relevant doc. The fix strengthens SYSTEM_PROMPT so the answer OPENS with what is
covered (cite `[N]`) and notes gaps after, reserving the "I couldn't find" opener strictly for
genuinely off-topic context — without breaking the legitimate off-topic refusal.

## Gate results (run synchronously in the worktree)

| Gate | Result |
|---|---|
| 1. `npm run build` (tsc) | PASS — exit 0, clean |
| 2. `npm test` (full) | PASS — 23 suites / 194 tests, exit 0 |
| 2b. prompt-integrity (3 blocks) | PASS — abstain + lead-with-found + new forceful strengthening all green |
| 3. Diff scope = prompt-only + test | PASS — only `src/llm/generate.ts` (+6/-1) + `tests/generate.prompt-integrity.test.ts` (+6) |
| 4. Plan-review guardrail (keys on RELEVANCE) | PASS — see analysis |
| 5. Privacy (public repo) | PASS — no brand/host/space-key/project-key |

## Detail

### AC1/AC2 — build + tests
`npm run build` exits 0 (tsc clean). `npm test` exits 0: `Test Suites: 23 passed, 23 total / Tests: 194 passed`. The three prompt-integrity blocks pass individually (`npx jest tests/generate.prompt-integrity.test.ts` → 3/3, exit 0), including the new assertion locking `MUST OPEN with what IS covered` + `RESERVED ONLY` + `off-topic`.

### AC3 — diff is prompt-only + test
`git diff HEAD~1 HEAD --stat` shows ONLY `src/llm/generate.ts` and `tests/generate.prompt-integrity.test.ts`. `selectCitedCitations`, `formatContext`, `buildCitations`, `offlineAnswer`, `generateAnswer`, and `NO_CONTEXT_ANSWER` are all UNCHANGED (read in full — the only change to line 16 is an additive parenthetical "(a clean refusal with no citations)"; the abstain clause text is preserved). Pure prompt + test.

### AC4 — plan-review guardrail (relevance-keyed, off-topic preserved)
The forceful rule triggers on RELEVANCE, not "chunks retrieved":
- MUST-OPEN trigger: "whenever the context contains ANY material RELEVANT to the question".
- Refusal opener: "RESERVED ONLY for the case where the context is genuinely off-topic and contains NO relevant information at all".

The two cases form a mutually-exclusive partition ON RELEVANCE, exactly as the guardrail required. The off-topic ABSTAIN path is preserved at two layers: (a) `generateAnswer` still returns `NO_CONTEXT_ANSWER` directly when `chunks.length === 0` (untouched); (b) at the LLM layer the prompt keeps both the explicit `ABSTAIN (off-topic context, no relevant material): … no citations` micro-line and the retained "If the context contains no relevant information, say you couldn't find the information" clause. The capital-of-Australia case (retriever returns off-topic chunks → no relevant material) lands cleanly in the ABSTAIN branch. Over-correction risk is LOW: the wording explicitly carves the off-topic/no-relevant-material case out of the MUST-OPEN rule, so it cannot suppress the legitimate refusal.

AC3-grep note: `git grep "I couldn't find" -- src/llm/generate.ts` matches three intentional sites — the reserved-opener constraint (line 11), the BAD example (line 13), and `NO_CONTEXT_ANSWER` (line 20). None mandates the "I couldn't find" opener for relevant context; this matches the plan's stated expectation.

### AC5 — privacy
The diff spells no employer brand / host / space-key / project-key. A case-insensitive scan for host/key/URL patterns returned no hits. The GOOD/BAD/ABSTAIN example uses only generic terms (Flutter, Riverpod, themes, API setup, "Initial Setup doc") — all permitted.

## Verdict
All five ACs hold. Build and tests green, diff is prompt-only + test, the forceful rule keys on relevance with the off-topic refusal preserved, and no privacy tokens leak.

Decision: PASS
