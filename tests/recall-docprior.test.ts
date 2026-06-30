import { applyDocPrior, DEFAULT_DOC_PRIOR_BONUS } from "../src/knowledge/docPrior";
import { hasHowToActionIntent } from "../src/knowledge/queryExpansion";
import { KnowledgeService } from "../src/knowledge/service";
import { VectorIndex } from "../src/index/vectorIndex";

/**
 * Tier-A — how-to-action doc-over-ticket prior (#1197). Synthetic, deterministic,
 * CI-safe. NONE of these queries echo a real fixture question (the real UAT
 * questions + ids live only in the gitignored private fixture). Both-ends:
 * every behavioral claim is paired with its WITHOUT case so the test fails if the
 * prior is a no-op AND if it over-fires.
 */

interface Scored {
  id: string;
  source: string;
  score: number;
}

function pool(): Scored[] {
  // Six ticket stubs the bi-encoder over-ranked on keyword density, plus one
  // narrative-DOC passage just below them (mirrors the real "#7 doc under a
  // 6-ticket wall" shape).
  return [
    { id: "t1", source: "jira:T-1", score: 0.5 },
    { id: "t2", source: "jira:T-2", score: 0.47 },
    { id: "t3", source: "jira:T-3", score: 0.43 },
    { id: "t4", source: "jira:T-4", score: 0.41 },
    { id: "t5", source: "jira:T-5", score: 0.39 },
    { id: "t6", source: "jira:T-6", score: 0.37 },
    { id: "d1", source: "confluence:C-1", score: 0.35 },
  ];
}

describe("hasHowToActionIntent — tightened classifier (correction #2)", () => {
  it("FIRES on genuine how-to-action phrasings", () => {
    expect(hasHowToActionIntent("how to reserve a slot")).toBe(true);
    expect(hasHowToActionIntent("how do I book a desk")).toBe(true);
    expect(hasHowToActionIntent("how can I cancel a booking")).toBe(true);
    // Q4-class "how does X work" DOES fire (correction #3 — reconciled below).
    expect(hasHowToActionIntent("how does the matching feature work")).toBe(true);
  });

  it("FIRES on the hyphenated / solid spelling of how-to", () => {
    expect(hasHowToActionIntent("how-to reserve a slot")).toBe(true); // hyphen compound
    expect(hasHowToActionIntent("howto find a spot")).toBe(true); //     solid compound
    expect(hasHowToActionIntent("how-do I book a desk")).toBe(true); //  hyphenated verb clause
  });

  it("does NOT fire on the greeting control", () => {
    expect(hasHowToActionIntent("how are you today")).toBe(false);
    expect(hasHowToActionIntent("how-are you")).toBe(false); //  hyphenated greeting
    expect(hasHowToActionIntent("how-to are you")).toBe(false); // to-bridge in the exclusion
  });

  it("does NOT fire on capacity / frequency / pricing 'how' questions (dropped loose clause)", () => {
    // These false-fired under the plan's anywhere-in-sentence clause 3, which was
    // DROPPED — their answers may live in a ticket, so the doc boost must NOT run.
    expect(hasHowToActionIntent("how many people can I add to a team")).toBe(false);
    expect(hasHowToActionIntent("how-many people can I add")).toBe(false); // hyphenated quantity
    expect(hasHowToActionIntent("how often do I get billed")).toBe(false);
    expect(hasHowToActionIntent("how much does it cost to book")).toBe(false);
  });

  it("does NOT fire on non-how phrasings", () => {
    expect(hasHowToActionIntent("what is the weekly schedule")).toBe(false);
    expect(hasHowToActionIntent("how it works")).toBe(false); // no interrogative+verb bind
    expect(hasHowToActionIntent("")).toBe(false);
  });
});

describe("applyDocPrior — both-ends reorder (correction #1: minimal bonus)", () => {
  it("lifts the DOC above ALL ticket stubs WITH how-to-action intent (equal scores)", () => {
    // Equal-score variant: every passage shares the query token, so any positive
    // bonus must move the doc above every ticket. Proves the boost path runs.
    const eq: Scored[] = [
      { id: "t1", source: "jira:T-1", score: 0.5 },
      { id: "t2", source: "jira:T-2", score: 0.5 },
      { id: "d1", source: "confluence:C-1", score: 0.5 },
    ];
    const out = applyDocPrior("how to reserve a slot", eq);
    expect(out[0].source).toBe("confluence:C-1");
  });

  it("DOES NOT reorder WITHOUT how-to-action intent (control-safety, no-op)", () => {
    const eq: Scored[] = [
      { id: "t1", source: "jira:T-1", score: 0.5 },
      { id: "t2", source: "jira:T-2", score: 0.5 },
      { id: "d1", source: "confluence:C-1", score: 0.5 },
    ];
    const out = applyDocPrior("how are you today", eq);
    // Byte-identical input order — the boost path never ran.
    expect(out.map((r) => r.id)).toEqual(["t1", "t2", "d1"]);
  });

  it("is a no-op when disabled (lever off → unchanged order)", () => {
    const out = applyDocPrior("how to reserve a slot", pool(), { enabled: false });
    expect(out.map((r) => r.id)).toEqual(pool().map((r) => r.id));
  });

  it("the minimal default bonus (0.15) lifts the buried DOC into the top-3 window without a doc-monopoly (#1201)", () => {
    // The #7 doc (score 0.35) under six tickets. #1201 raised the default to 0.15
    // (the minimal value that clears the measured real-index ticket-gap and lands
    // the how-to doc at rank #1 on the REAL corpus). This SYNTHETIC pool's gap is
    // wider (0.50 - 0.35 = 0.15) so +0.15 exactly TIES the top ticket and the
    // stable re-sort keeps the ticket ahead — the doc rises to #2 here, NOT #1.
    // This is the mechanism test (the value + the doc rising into the grounding
    // window without monopolizing it); the real-index rank-#1 grounding is the
    // Tier-B measurement, not a synthetic-pool assertion.
    expect(DEFAULT_DOC_PRIOR_BONUS).toBe(0.15);
    const out = applyDocPrior("how do I find a spot", pool());
    const docRank = out.findIndex((r) => r.source === "confluence:C-1") + 1;
    expect(docRank).toBeGreaterThanOrEqual(1);
    expect(docRank).toBeLessThanOrEqual(3);
    // No doc-monopoly: tickets retain the top seats (the top ticket still leads).
    expect(out[0].source).toBe("jira:T-1");
  });

  it("reorders only — never mutates the stored score", () => {
    const input = pool();
    const out = applyDocPrior("how to reserve a slot", input);
    const doc = out.find((r) => r.source === "confluence:C-1");
    expect(doc?.score).toBe(0.35); // original score preserved
  });

  it("Q4-class 'how does X work' FIRES but causes NO regression when the DOC is already #1 (correction #3)", () => {
    // The prior MAY fire on a "how does X work" phrasing; no harm because the
    // grounding doc passage is already the top result — a uniform doc bonus
    // keeps it #1 (this is the Q4 no-regression mechanism: fires-but-no-harm,
    // NOT byte-identical-by-construction).
    const docTop: Scored[] = [
      { id: "d1", source: "confluence:C-1", score: 0.6 }, // already #1
      { id: "t1", source: "jira:T-1", score: 0.5 },
      { id: "t2", source: "jira:T-2", score: 0.48 },
    ];
    expect(hasHowToActionIntent("how does the matching feature work")).toBe(true);
    const out = applyDocPrior("how does the matching feature work", docTop);
    expect(out[0].source).toBe("confluence:C-1"); // still #1 — no regression
    expect(out.map((r) => r.id)).toEqual(["d1", "t1", "t2"]);
  });
});

describe("KnowledgeService wiring — docPrior ON by default (correction #4)", () => {
  async function buildIndex(
    docs: Array<{ source: string; text: string }>,
  ): Promise<VectorIndex> {
    const index = new VectorIndex();
    await index.add(docs.map((d) => ({ text: d.text, source: d.source })));
    return index;
  }

  // jira stubs added first + one confluence last, all sharing the query token →
  // equal bi-encoder scores → insertion order puts confluence last by default.
  const docs = [
    { source: "jira:T-1", text: "alpha alpha" },
    { source: "jira:T-2", text: "alpha alpha" },
    { source: "jira:T-3", text: "alpha alpha" },
    { source: "confluence:C-1", text: "alpha alpha" },
  ];

  it("a how-to-action query lifts the confluence passage above the jira stubs via full retrieve()", async () => {
    // NO recall opts → docPrior ON by default (proves it runs in production defaults).
    const svc = new KnowledgeService({ index: await buildIndex(docs), topK: 12 });
    const hits = await svc.retrieve("how to use alpha");
    expect(hits[0].source).toBe("confluence:C-1");
  });

  it("a NON-how-to query leaves the jira-first order unchanged (control-safety, live path)", async () => {
    const svc = new KnowledgeService({ index: await buildIndex(docs), topK: 12 });
    const hits = await svc.retrieve("what is alpha");
    expect(hits[0].source.startsWith("jira:")).toBe(true);
  });

  it("docPrior explicitly OFF → how-to-action query no longer reorders", async () => {
    const svc = new KnowledgeService({
      index: await buildIndex(docs),
      topK: 12,
      recall: { docPrior: { enabled: false } },
    });
    const hits = await svc.retrieve("how to use alpha");
    expect(hits[0].source.startsWith("jira:")).toBe(true);
  });
});
