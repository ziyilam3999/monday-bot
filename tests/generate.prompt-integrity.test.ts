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
});
