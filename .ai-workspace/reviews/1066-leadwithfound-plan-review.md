# Plan review — 1066 lead-with-found, iteration 2 (strengthen SYSTEM_PROMPT)

Role: plan-review (stateless). Scope: prompt-only fix to `src/llm/generate.ts` SYSTEM_PROMPT + one new
assertion in `tests/generate.prompt-integrity.test.ts`. I read the plan, the target source, and the test.

cairn: no node CLI run from this subagent shell; lesson source is the in-session UAT retest (per plan). The
governing prior-art is the in-repo #1066 P3 abstention-bias clause already documented in the test header.

## Verdict summary

PASS with REQUIRED guardrails. The plan's intent is correct and the change is appropriately small and
single-surface. But the over-correction risk in Q1/Q3 is real and hinges entirely on ONE word — "relevant" —
and AC3 is factually imprecise against the actual source. Both are wording-level fixes the executor must fold
in; neither is architectural, so this does not block. The four points below are mandatory inputs to the
executor, not optional suggestions.

---

## Q1 — Does it solve led-with-abstention WITHOUT breaking the genuine off-topic refusal?

Intent: yes. Risk: real, and it lives in the trigger condition, not the forcefulness.

Critical fact from the source: `generateAnswer` only returns `NO_CONTEXT_ANSWER` when `chunks.length === 0`
(line 117) or the model emits empty text (line 165). In the live path the retriever ALWAYS hands the LLM a
non-empty top-k chunk set — including the capital-of-Australia case, where the chunks are present but
OFF-TOPIC. So abstention is a JUDGMENT the model makes over non-empty context; it is NOT signalled by
"no chunks."

Consequence: a forceful rule phrased as "MUST OPEN with what you found WHEN CHUNKS WERE RETRIEVED" is
DANGEROUS — chunks are essentially always retrieved, so that trigger fires on the Australia case too and
would suppress the legitimate refusal. The plan's prose in the Fix bullet literally writes
"MUST NOT open with 'I couldn't find…' when relevant chunks were retrieved" — the word "relevant" is doing
100% of the safety work. If the executor drops or softens "relevant" to "retrieved"/"present"/"any chunks,"
the off-topic refusal breaks.

REQUIRED guardrail G1: the forceful MUST-OPEN rule must be explicitly scoped to chunks that ACTUALLY ADDRESS
the question ("relevant material" / "any source that genuinely bears on the question"), never to mere
retrieval/presence. The abstain clause must own the exact complement ("when NONE of the provided sources are
relevant to the question"). State the relevance test once and have both clauses reference it.

## Q3 — Do both clauses (abstain phrase + forceful MUST-OPEN) contradict, and how to wall it off?

They do not contradict IF and ONLY IF they partition the space on RELEVANCE and are mutually exclusive. They
DO contradict if the trigger is "chunks retrieved," because then both clauses claim the same (always-true)
condition and the model resolves the overlap arbitrarily — either never abstaining (breaks Australia) or
continuing to abstain (no fix, the iteration-1 failure repeats).

REQUIRED guardrail G2 (wording): make the two clauses a clean partition with no overlap, e.g.

- "If ANY provided source is relevant to the question, you MUST open with what those sources cover and cite
  it `[N]`; note any gap only AFTER. You MUST NOT open with 'I couldn't find…' in this case."
- "ONLY if NONE of the provided sources are relevant to the question, say you couldn't find the information
  (no citations)."

REQUIRED guardrail G3 (the GOOD/BAD example must anchor the BOUNDARY, not just the format): the BAD example
should show the exact iteration-1 failure — relevant material present, yet the reply LED with
"I couldn't find specific instructions…". The GOOD example should show partial-but-relevant info led with
first, gap noted after. Strongly consider a THIRD micro-line illustrating the legitimate abstain on truly
off-topic context (the capital-of-Australia shape), so the example set itself demonstrates that the forceful
rule does not eat the refusal. Without that third anchor the example teaches "always lead with found" and
re-introduces the over-correction the example was meant to prevent.

## Q2 — Are the Binary AC checkable from outside the diff?

- AC1 (`npm run build` exit 0) and AC2 (`npm test` exit 0): yes, fully external, exit-code checkable.
- AC4 (integrity test asserts three clauses present): yes, this is the real external gate. REQUIRED: the new
  third assertion must be a SPECIFIC regex that locks the forceful/relevance-scoped strengthening (e.g. it
  should require both a MUST-style token AND the relevance scoping, not merely match the word "must"), so a
  future soften-to-"retrieved" reword re-trips the test. A loose regex here defeats the whole guard.
- AC3 (`git grep -nE "I couldn't find" -- src/llm/generate.ts` … "ONLY inside the BAD example and abstain
  clause"): FACTUALLY IMPRECISE against the current source — two corrections needed:
  1. The SYSTEM_PROMPT abstain clause (line 11) reads "say you **you couldn't find** the information" with a
     lowercase "you couldn't find" — it does NOT contain the capitalized "I couldn't find," so the grep does
     NOT match it. AC3 naming "the abstain clause" as a match site is wrong.
  2. `NO_CONTEXT_ANSWER` (line 15) IS "I couldn't find any relevant information…" and DOES match the grep —
     AC3 omits this legitimate third occurrence entirely. An executor following AC3 literally would be
     confused by an "extra" match.
  REQUIRED guardrail G4: rewrite AC3 to enumerate the real expected match sites post-fix — the new BAD
  example AND the `NO_CONTEXT_ANSWER` constant — and assert "I couldn't find" never appears as the SYSTEM_PROMPT's
  mandated opener for relevant context. Better: fold the negative into the integrity test (AC4) as a mechanical
  assertion rather than relying on an eyeballed grep. AC3 as written secretly requires reading the source to
  judge "ONLY inside the BAD example," which is borderline how-prescription; the mechanical version is the
  match-count/site grep.

Net: AC1/AC2/AC4 are sound external gates; AC3 must be corrected (G4) but is a secondary sanity check, not
the load-bearing gate.

## Q4 — Privacy risk in the GOOD/BAD example terms (Flutter, Riverpod, themes, API setup, "Initial Setup doc")?

Low risk, ACCEPTABLE with one caution. Flutter and Riverpod are public Google/OSS technologies; "themes,"
"API setup," and "Initial Setup doc" are generic. None is an employer brand, host, space-key, or project-key.

Caution (not a blocker): the live UAT failure referenced a real retrieved "Initial-Setup" item / "checklist
of initial setup tasks." The example must stay FULLY SYNTHETIC — do not copy the real doc's exact heading,
ticket id, or body text into the prompt, and keep "Initial Setup doc" as a generic placeholder, not the real
artifact's title. The plan already mandates a `git grep` diff for the regulated token and a green `denylist`
CI before push; keep both. With the synthetic-example discipline, privacy passes.

---

## Scope / safety checks

- Prompt-only: the Fix and AC sections correctly forbid touching `selectCitedCitations` / the formatter. Good.
- Both load-bearing clauses retained so the existing two integrity assertions stay green: confirmed against
  the test — `/no relevant information/i`, `/couldn't find/i`, `/Lead with what you DID find/` must all still
  match after the reword. The relevance-partition wording in G2 preserves all three; the executor must verify
  the literal "Lead with what you DID find" and "no relevant information" substrings survive the reword.
- Execution model: planner inline-skip is defensible for a single-surface prompt reword tightly coupled to
  the exact UAT string; plan-review / executor / execution-review as real subagents is correct.

## Required-before-execute checklist (fold into the executor brief)

1. G1 — trigger the forceful rule on RELEVANCE, never on "chunks retrieved/present."
2. G2 — make abstain vs lead-with-found a mutually-exclusive partition on relevance.
3. G3 — GOOD/BAD example anchors the boundary; add a third off-topic-abstain micro-line.
4. G4 — fix AC3 to name the real grep match sites (BAD example + `NO_CONTEXT_ANSWER`, NOT the abstain clause);
   make AC4's new assertion a specific relevance-locking regex.
5. Keep the three existing integrity substrings intact; synthetic example only; privacy-grep + denylist green.

Decision: PASS
