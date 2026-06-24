import { SYSTEM_PROMPT } from "../src/llm/generate";

/**
 * Layer-B guard test for the answer-quality system prompt.
 *
 * The #1066 P3 abstention-bias fix added two load-bearing clauses to
 * SYSTEM_PROMPT: an abstain rule ("if you found nothing relevant, say you
 * couldn't find it") and a lead-with-found rule. A future prompt refactor could
 * silently delete one and quietly regress answer quality with no test failure.
 * These assertions fail loudly if either clause disappears, so a reword becomes
 * a conscious decision that re-trips this test.
 *
 * Importing SYSTEM_PROMPT must NOT require any env (getClient is lazy) — this
 * test runs without ANTHROPIC credentials.
 */
describe("SYSTEM_PROMPT integrity", () => {
  it("retains the abstain rule (no relevant info -> say you couldn't find it)", () => {
    expect(SYSTEM_PROMPT).toMatch(/no relevant information/i);
    expect(SYSTEM_PROMPT).toMatch(/couldn't find/i);
  });

  it("retains the lead-with-found rule", () => {
    expect(SYSTEM_PROMPT).toMatch(/Lead with what you DID find/);
  });

  it("retains the forceful lead-with-found strengthening (MUST OPEN + reserved-only abstain)", () => {
    expect(SYSTEM_PROMPT).toMatch(/MUST OPEN with what IS covered/);
    expect(SYSTEM_PROMPT).toMatch(/RESERVED ONLY/);
    expect(SYSTEM_PROMPT).toMatch(/off-topic/i);
  });

  // #1195 — answer-framing grounding clauses.
  it("adds the process/spec-doc grounding clause (#1195 Item 1)", () => {
    expect(SYSTEM_PROMPT).toMatch(/PROCESS\/SPEC DOCS COUNT AS GROUNDING/);
    expect(SYSTEM_PROMPT).toMatch(/describes the relevant PROCESS, MECHANISM, business rules, or spec/);
  });

  it("conditions the process/spec clause INLINE on on-topic relevance (#1195 correction 4)", () => {
    // Presence != conditioned: the widening clause must carry its relevance
    // precondition in the prompt wording itself, not only lean on the abstain
    // clause. This asserts the inline on-topic gate is stated.
    expect(SYSTEM_PROMPT).toMatch(/applies ONLY when that passage is genuinely ON-TOPIC/);
    expect(SYSTEM_PROMPT).toMatch(/about a DIFFERENT topic than the question is NOT grounding/);
  });

  it("prefers document/narrative sources over bare ticket stubs (#1195 Item 1)", () => {
    expect(SYSTEM_PROMPT).toMatch(/PREFER DOCS OVER TICKET STUBS/);
  });

  // #1201 — single-product / proper-noun-absence hedge fix.
  it("adds the single-product / proper-noun-absence clause (#1201 new clause)", () => {
    expect(SYSTEM_PROMPT).toMatch(/SINGLE-PRODUCT KNOWLEDGE BASE/);
    expect(SYSTEM_PROMPT).toMatch(/ABSENCE of the product'?s or a feature'?s NAME/i);
    expect(SYSTEM_PROMPT).toMatch(/DESCRIBE THE TOPIC OR FEATURE/i);
  });

  it("carries the no-yes-man clamp (mentions product but not the topic -> still decline) (#1201)", () => {
    expect(SYSTEM_PROMPT).toMatch(
      /merely mentions or is generally about the product but does NOT address the specific topic .* is NOT grounding/i,
    );
  });

  it("cross-references the still-governing on-topic precondition (#1201 correction #3)", () => {
    // The new clause removes ONLY proper-noun absence as a disqualifier; it must
    // NOT relax the existing genuinely-ON-TOPIC gate (generate.ts on-topic clause).
    expect(SYSTEM_PROMPT).toMatch(/removes ONLY proper-noun ABSENCE as a disqualifier/);
    expect(SYSTEM_PROMPT).toMatch(/genuinely ON-TOPIC precondition above still governs/);
  });

  it("adds the phased/planned-rollout framing clause (#1195 Item 3)", () => {
    expect(SYSTEM_PROMPT).toMatch(/PHASED \/ PLANNED ROLLOUTS/);
    expect(SYSTEM_PROMPT).toMatch(/what is LIVE now and what is NAMED-planned/);
    expect(SYSTEM_PROMPT).toMatch(/do NOT dismiss a roadmap as/);
  });
});
