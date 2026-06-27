import {
  categorizeDefect,
  categorizeAll,
  DEFECT_CATEGORIES,
  DefectCategory,
  DefectInput,
} from "../src/triage/categorizeDefect";

/**
 * Synthetic fixtures — ALL invented placeholder text shaped like real entries.
 * No internal hostname, project/space key, colleague name, or codename (PS-1/PS-2).
 * One fixture per category, including the `other` fallback.
 */
const SYNTHETIC: Array<{ input: DefectInput; expected: DefectCategory }> = [
  {
    input: { key: "X-1", summary: "handler silently swallows errors and returns empty", issueType: "Bug" },
    expected: "correctness-bug",
  },
  {
    input: { key: "X-2", summary: "rename mockFoo for test-runner hoist compatibility", labels: ["chore"] },
    expected: "test-infra",
  },
  {
    input: { key: "X-3", summary: "doc page: link the changelog instead of an inline date", issueType: "Task" },
    expected: "documentation",
  },
  {
    input: { key: "X-4", summary: "tighten the Foo type to forbid the empty case", issueType: "Bug" },
    expected: "type-safety",
  },
  {
    input: { key: "X-5", summary: "extract duplicated factory into one helper", labels: ["refactor"] },
    expected: "code-quality",
  },
  {
    input: { key: "X-6", summary: "add an optional pagination knob to the fetcher", issueType: "Story" },
    expected: "enhancement",
  },
  {
    input: { key: "X-7", summary: "miscellaneous unclassifiable note", labels: [] },
    expected: "other",
  },
];

describe("categorizeDefect — taxonomy + rules", () => {
  it("AC-3: at least one synthetic input lands in EACH category (incl. other) — no dead category", () => {
    const landed = new Set<DefectCategory>();
    for (const { input, expected } of SYNTHETIC) {
      const { category } = categorizeDefect(input);
      expect(category).toBe(expected);
      landed.add(category);
    }
    // Enum-completeness loop: every declared category is reachable by a fixture.
    for (const category of DEFECT_CATEGORIES) {
      expect(landed.has(category)).toBe(true);
    }
  });

  it("AC-4: determinism — same input twice yields an identical result", () => {
    for (const { input } of SYNTHETIC) {
      const a = categorizeDefect(input);
      const b = categorizeDefect(input);
      expect(a).toEqual(b);
    }
    // A representative deep-equality check, not just category.
    const sample = { summary: "crash: null pointer exception in the cast path" };
    expect(categorizeDefect(sample)).toEqual(categorizeDefect(sample));
  });

  it("AC-5: precedence — an input matching two type-rules resolves to the higher one", () => {
    // Matches BOTH correctness-bug (crash/throws/null pointer/exception) AND
    // type-safety (cast/type). Precedence: correctness-bug > type-safety.
    const multi: DefectInput = {
      summary: "crash: the cast to the Foo type throws a null pointer exception",
    };
    const { category } = categorizeDefect(multi);
    expect(category).toBe("correctness-bug");

    // And a test-infra vs code-quality collision: "rename" (code-quality) +
    // "test-runner"/"mock" (test-infra). Precedence: test-infra > code-quality.
    const collide: DefectInput = { summary: "rename the mock in the test-runner setup" };
    expect(categorizeDefect(collide).category).toBe("test-infra");
  });

  it("fallback — an unmatched input is `other` / matchedRule: fallback", () => {
    const r = categorizeDefect({ summary: "miscellaneous unclassifiable note" });
    expect(r.category).toBe("other");
    expect(r.matchedRule).toBe("fallback");
  });
});

describe("categorizeAll — grouped counts", () => {
  it("AC-6: per-category counts equal the per-result tally", () => {
    const inputs = SYNTHETIC.map((s) => s.input);
    const { results, counts } = categorizeAll(inputs);

    // Every category key is present (seeded at 0).
    for (const category of DEFECT_CATEGORIES) {
      expect(counts).toHaveProperty(category);
    }

    // counts == manual tally over results.
    const tally = Object.fromEntries(DEFECT_CATEGORIES.map((c) => [c, 0])) as Record<
      DefectCategory,
      number
    >;
    for (const r of results) tally[r.category] += 1;
    expect(counts).toEqual(tally);

    // Sum of counts == number of inputs (every defect lands in exactly one bucket).
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(inputs.length);
  });
});
