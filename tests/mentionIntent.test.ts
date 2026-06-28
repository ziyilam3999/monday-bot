import {
  classifyMentionIntent,
  DEFAULT_MENTION_DEFECT_LEXICON,
  DEFAULT_MENTION_JQL_LEAD_TOKENS,
} from "../src/slack/commands";

/**
 * #1344 — PURE mention-intent classifier. ZERO network. Synthetic vocab only
 * (example.atlassian.net / DEMO-* keys / invented feature names). These tests
 * lock the binary routing ACs: AC3 (whole-word positives → jql), AC9 (ambiguous
 * → doc), AC10 (substring-leak guard → doc), AC4/AC11 (lead-token whole-word +
 * strip).
 */

describe("classifyMentionIntent — AC3: whole-word defect mentions route to jql", () => {
  const positives = [
    "show me the crashes",
    "list open bugs",
    "any regressions in DEMO-123",
  ];
  for (const text of positives) {
    it(`routes "${text}" → jql (query unchanged)`, () => {
      const out = classifyMentionIntent(text);
      expect(out.route).toBe("jql");
      // No lead token here → the query is forwarded unchanged.
      expect(out.query).toBe(text);
    });
  }
});

describe("classifyMentionIntent — AC9: ambiguous / plain doc questions route to doc (safe default)", () => {
  const docs = [
    "how many days of annual leave do I get?",
    "what is the wifi password?",
    "tell me about the onboarding process",
  ];
  for (const text of docs) {
    it(`routes "${text}" → doc`, () => {
      const out = classifyMentionIntent(text);
      expect(out.route).toBe("doc");
      expect(out.query).toBe(text);
    });
  }
});

describe("classifyMentionIntent — AC10: SUBSTRING-LEAK GUARD (word-boundary, not includes())", () => {
  // Each phrase HIDES a real section-2 lexicon token inside a LONGER word and
  // NONE is a standalone whole-word defect noun → all must route doc. A naive
  // text.includes("bug"/"symptom"/"defect") would misroute every one to jql.
  const traps: Array<[string, string]> = [
    ["where is the debugging guide?", "bug ⊂ debugging"],
    ["can I see the debugger output page?", "bug ⊂ debugger"],
    ["what is the asymptomatic screening policy?", "symptom ⊂ asymptomatic"],
    ["how do I file the defective hardware return form?", "defect ⊂ defective"],
  ];
  for (const [text, why] of traps) {
    it(`routes "${text}" → doc (${why})`, () => {
      expect(classifyMentionIntent(text).route).toBe("doc");
    });
  }

  it("a naive substring matcher would have FAILED these — proves word-boundary is load-bearing", () => {
    // Sanity: each trap DOES contain a lexicon token as a bare substring, so the
    // only way all four route doc is genuine word-boundary matching.
    const anySubstringHit = traps.every(([text]) =>
      DEFAULT_MENTION_DEFECT_LEXICON.some((tok) => text.toLowerCase().includes(tok)),
    );
    expect(anySubstringHit).toBe(true);
  });
});

describe("classifyMentionIntent — AC4/AC11: explicit lead token is a WHOLE WORD, stripped on route", () => {
  it('"jql show me crashes" → jql with the lead token stripped (query = "show me crashes")', () => {
    const out = classifyMentionIntent("jql show me crashes");
    expect(out.route).toBe("jql");
    expect(out.query).toBe("show me crashes");
  });

  it('"defects: aurora checkout" → jql with the lead token stripped (query = "aurora checkout")', () => {
    const out = classifyMentionIntent("defects: aurora checkout");
    expect(out.route).toBe("jql");
    expect(out.query).toBe("aurora checkout");
  });

  it('"jqlite query language docs" → doc (jql is only a substring of a longer word)', () => {
    const out = classifyMentionIntent("jqlite query language docs");
    expect(out.route).toBe("doc");
    expect(out.query).toBe("jqlite query language docs");
  });

  it('"defectsense onboarding" → doc (defects is only a substring of a longer word)', () => {
    const out = classifyMentionIntent("defectsense onboarding");
    expect(out.route).toBe("doc");
    expect(out.query).toBe("defectsense onboarding");
  });
});

describe("classifyMentionIntent — configurable lexicon (override without a code change)", () => {
  it("an injected lexicon overrides the default (no env, pure)", () => {
    // "outage" is NOT in the default lexicon → doc by default…
    expect(classifyMentionIntent("any outage today?").route).toBe("doc");
    // …but routes jql when the caller supplies a lexicon containing it.
    expect(
      classifyMentionIntent("any outage today?", { lexicon: ["outage"] }).route,
    ).toBe("jql");
  });

  it("exposes the default lexicon + lead tokens as named constants", () => {
    expect(DEFAULT_MENTION_DEFECT_LEXICON).toEqual([
      "defect",
      "bug",
      "crash",
      "regression",
      "symptom",
    ]);
    expect(DEFAULT_MENTION_JQL_LEAD_TOKENS).toEqual(["jql", "defects:"]);
  });
});
