import {
  categorizeDefect,
  categorizeAll,
  DEFECT_CATEGORIES,
  DefectCategory,
  DefectInput,
} from "../src/triage/categorizeDefect";

/**
 * Synthetic fixtures — ALL invented, generic-English symptom sentences. No real
 * defect text, product name, feature name, codename, hostname, or project/space
 * key. One fixture per symptom category, including the `other` fallback.
 *
 * Fixture-isolation: `cannot-complete` and `display-ui` are broad + high in
 * precedence, so each per-bucket fixture is crafted to trigger on a word UNIQUE to
 * its intended bucket and to avoid any higher-precedence bucket's vocabulary
 * (precedence: crash-error > cannot-complete > data-incorrect > missing-element >
 * display-ui > navigation-flow > performance > other).
 */
const SYNTHETIC: Array<{ input: DefectInput; expected: DefectCategory }> = [
  {
    input: { key: "X-1", summary: "the application crashed unexpectedly on launch" },
    expected: "crash-error",
  },
  {
    input: { key: "X-2", summary: "the user is unable to submit the new entry" },
    expected: "cannot-complete",
  },
  {
    input: { key: "X-3", summary: "the running total shows the wrong amount" },
    expected: "data-incorrect",
  },
  {
    input: { key: "X-4", summary: "the avatar is missing after saving" },
    expected: "missing-element",
  },
  {
    input: { key: "X-5", summary: "the button label overlaps the icon" },
    expected: "display-ui",
  },
  {
    input: { key: "X-6", summary: "the navigation transition skips a route" },
    expected: "navigation-flow",
  },
  {
    input: { key: "X-7", summary: "the feed is very slow and takes too long" },
    expected: "performance",
  },
  {
    input: { key: "X-8", summary: "general miscellaneous note" },
    expected: "other",
  },
];

describe("categorizeDefect — symptom taxonomy + rules", () => {
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

  it("AC-5: determinism — same input twice yields an identical result", () => {
    for (const { input } of SYNTHETIC) {
      const a = categorizeDefect(input);
      const b = categorizeDefect(input);
      expect(a).toEqual(b);
    }
    // A representative deep-equality check, not just category (re-grounded to a
    // new-taxonomy fixture that lands in crash-error).
    const sample = { summary: "the application crashed unexpectedly" };
    expect(categorizeDefect(sample)).toEqual(categorizeDefect(sample));
  });

  it("AC-4: precedence — an input matching two rules resolves to the HIGHER one", () => {
    // Collision near the TOP: matches crash-error (crashed) AND data-incorrect
    // (wrong/total). Precedence: crash-error > data-incorrect.
    const high: DefectInput = {
      summary: "the app crashed and then showed the wrong total",
    };
    expect(categorizeDefect(high).category).toBe("crash-error");

    // A SECOND collision LOWER in the order: matches navigation-flow (redirect)
    // AND performance (slow/laggy). Precedence: navigation-flow > performance.
    const low: DefectInput = { summary: "the redirect is slow and laggy" };
    expect(categorizeDefect(low).category).toBe("navigation-flow");
  });

  it("fallback — an unmatched input is `other` / matchedRule: fallback", () => {
    const r = categorizeDefect({ summary: "general miscellaneous note" });
    expect(r.category).toBe("other");
    expect(r.matchedRule).toBe("fallback");
  });
});

describe("categorizeDefect — #1333 precedence-theft fix", () => {
  // Synthetic fixtures (invented generic-English) proving the #1333 fix:
  // (1) rules match the SUMMARY only — a stray "error" in the description no
  //     longer steals a ticket into crash-error; (2) the bare "flow" token is
  //     dropped from navigation-flow so a "Flow …" naming prefix is not auto-filed
  //     as navigation. AC-1/AC-2 are RED on master, GREEN after the fix; AC-3
  //     guards that real navigation phrasing still classifies as navigation-flow.

  it("#1333 theft-1: description boilerplate 'error' does NOT steal a data-incorrect summary", () => {
    // Summary is a data-incorrect symptom; the description carries the QA
    // boilerplate word "error". Pre-fix (summary+description) → crash-error.
    // Post-fix (summary only) → data-incorrect.
    const input: DefectInput = {
      summary: "the running total shows the wrong amount",
      descriptionText:
        "Steps to reproduce: open the screen. Expected result: correct value. Actual result: an error occurred.",
    };
    expect(categorizeDefect(input).category).toBe("data-incorrect");
  });

  it("#1333 theft-2: a bare 'Flow' naming prefix is NOT auto-filed as navigation-flow", () => {
    // Summary begins with the "Flow" naming prefix and contains no other symptom
    // keyword. Pre-fix the bare "flow" token fired navigation-flow; post-fix it
    // falls through to `other`.
    const input: DefectInput = {
      summary: "Flow Reports: revisit the quarterly digest wording",
    };
    expect(categorizeDefect(input).category).toBe("other");
  });

  it("#1333 nav-guard: genuine navigation phrasing still classifies as navigation-flow", () => {
    // Removing the bare "flow" token must not break real navigation matching:
    // redirect/route still trigger navigation-flow. Stays GREEN before and after.
    const input: DefectInput = {
      summary: "the redirect loops back to the previous route",
    };
    expect(categorizeDefect(input).category).toBe("navigation-flow");
  });
});

describe("#1341 keyword enrichment", () => {
  // PART A — five generic keyword adds (the `jump` add was dropped per
  // plan-review S1 to avoid stealing display/scroll "jump" symptoms). Each
  // fixture is SYNTHETIC and isolates its NEW keyword: the only token that
  // triggers the target category is the newly-added one.
  const PART_A: Array<{ summary: string; expected: DefectCategory; note: string }> = [
    { summary: "the eta is not accurate", expected: "data-incorrect", note: "A1 accurate" },
    { summary: "the upload didn't finish", expected: "cannot-complete", note: "A3 didn't" },
    { summary: "the session expired", expected: "cannot-complete", note: "A4 expired" },
    { summary: "the link expires too early", expected: "cannot-complete", note: "A4 expires (S3 widening)" },
    { summary: "the save control is not there", expected: "missing-element", note: "A5 not there" },
    { summary: "a pop up covers the panel", expected: "display-ui", note: "A6 pop up" },
  ];

  it.each(PART_A)("PART A: %o classifies to its target category", ({ summary, expected }) => {
    expect(categorizeDefect({ summary }).category).toBe(expected);
  });

  // Extension-via-injected-object (no file I/O) — proves the B.3 precedence
  // wiring directly. `frobnicate`/`wibble` are invented terms that match no
  // built-in rule, so they isolate the extension behavior cleanly.
  it("extension term lands in its category with a :ext matchedRule", () => {
    const extraRules = { performance: [/frobnicate/i] };
    const r = categorizeDefect({ summary: "the page will frobnicate on open" }, extraRules);
    expect(r.category).toBe("performance");
    expect(r.matchedRule.endsWith(":ext")).toBe(true);
  });

  it("a higher BASE rule still outranks a lower-rank extension", () => {
    const extraRules = { performance: [/frobnicate/i] };
    // Also hits crash-error (crashed) at rank 1 — base wins over a performance ext.
    const r = categorizeDefect(
      { summary: "the app crashed while it tried to frobnicate" },
      extraRules,
    );
    expect(r.category).toBe("crash-error");
  });

  it("an extension is evaluated at its category's RANK, not appended after other", () => {
    const extraRules = { "missing-element": [/frobnicate/i] };
    const r = categorizeDefect({ summary: "the widget will frobnicate" }, extraRules);
    expect(r.category).toBe("missing-element");
  });

  it("no-extensions parity: a synthetic term matches nothing built-in (one-arg → other)", () => {
    expect(categorizeDefect({ summary: "the page will frobnicate on open" }).category).toBe(
      "other",
    );
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
