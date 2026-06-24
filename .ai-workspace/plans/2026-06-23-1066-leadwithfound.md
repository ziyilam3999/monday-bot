# 1066 — Lead-with-found, iteration 2 (strengthen the system prompt)

## ELI5
The help-bot reads company docs and answers questions. When someone asked "how do I set up my local dev environment?", the bot DID find the right doc, but it still started its reply with "I couldn't find specific instructions…". That makes it sound clueless even though it found useful stuff. Last release we just moved the rule around in the bot's instructions; that was too gentle and the bot ignored it. This time we make the rule LOUD and add a worked example so the bot can't miss it: if you found anything relevant, OPEN with what you found, then mention the gap after. Only say "I couldn't find anything" when the docs are truly off-topic (like asking the capital of Australia).

## Execution model
subagent — plan-review, executor, and execution-review each run as a real, stateless, write-capable
subagent per operator mandate. Planner is inline-skip (rationale in ## Roles): the change is a tiny
single-surface prompt reword tightly coupled to the exact in-session UAT failure string, with no
architectural decision; the brief below is the whole contract.

## Problem
Live UAT retest: for "how do I set up my local development environment?" the bot replied
"I couldn't find specific instructions for setting up your local development environment in the
provided context. The context includes a checklist of initial setup tasks [1]…" — it retrieved the
relevant Initial-Setup ticket but still LED with abstention. The v0.12.11 prompt reorder was too weak.

## Fix (prompt-only — src/llm/generate.ts SYSTEM_PROMPT)
- Strengthen the lead-with-found rule to FORCEFUL + explicit: when context has ANY relevant material the
  answer MUST OPEN with what IS covered (cite `[N]`), note gaps AFTER. MUST NOT open with "I couldn't find…"
  when relevant chunks were retrieved.
- Reserve "I couldn't find any relevant information" ONLY for genuinely-irrelevant/off-topic context
  (clean refusal, no citations) — the capital-of-Australia case stays working.
- Add a concrete GOOD/BAD contrast example IN the prompt to anchor it.
- KEEP both load-bearing clauses intact (abstain + lead-with-found) so the integrity test stays green;
  ADD a new assertion locking the forceful strengthening.
- DO NOT touch `selectCitedCitations` / the formatter — prompt-only.

## Constraints
- Public repo: no employer brand / host / space-key / project-key anywhere (the GOOD/BAD example uses only
  generic tech terms: Flutter, Riverpod, themes, API setup). Git-grep diff before push. `denylist` CI must stay green.
- npm run build + tsc clean; npm test all green incl. tests/generate.prompt-integrity.test.ts.

## Plan-review guardrails (folded in)
- The forceful rule MUST key on RELEVANCE ("context contains material RELEVANT to the question"), NOT on
  "chunks were retrieved" — the live retriever always returns a non-empty top-k, and `generateAnswer`
  only abstains when `chunks.length === 0`. A "when chunks retrieved" trigger would wrongly suppress the
  legitimate off-topic refusal. The lead-with-found case and the abstain case must form a mutually
  exclusive partition ON RELEVANCE.
- Add a third off-topic ABSTAIN micro-line to the in-prompt example so the boundary is anchored explicitly.

## Binary AC
1. `npm run build` exits 0 (tsc clean) in the worktree.
2. `npm test` exits 0 (all suites green, incl. prompt-integrity).
3. `git grep -nE "I couldn't find" -- src/llm/generate.ts` matches ONLY `NO_CONTEXT_ANSWER` (line ~15)
   and the new BAD example — never as the mandated opener for relevant context. (The SYSTEM_PROMPT abstain
   clause itself uses lowercase "you couldn't find", so it is not expected to match this grep.)
4. The prompt-integrity test asserts THREE things present: abstain clause, lead-with-found clause, and the
   new forceful "MUST OPEN / reserved-only" strengthening.

## Roles
- planner: inline-skip — tiny single-surface prompt reword tightly coupled to the exact in-session UAT
  failure string; no architecture, brief is the whole contract.
- plan-review: real subagent (stateless, write-capable).
- executor: real subagent (write-capable) — edits SYSTEM_PROMPT + test.
- execution-review: real subagent (stateless, write-capable).

cairn: no employer-token / abstention hits surfaced locally; lesson source is the in-session UAT retest.

## Review
plan-review: PASS (with guardrails, folded into the plan above) — subagent a6354ea2efd72ce6f.
See .ai-workspace/reviews/1066-leadwithfound-plan-review.md
