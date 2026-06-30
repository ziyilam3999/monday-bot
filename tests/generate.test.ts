import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentHome = tmpdir();

jest.mock("node:os", () => {
  const actual = jest.requireActual("node:os") as typeof import("node:os");
  return {
    ...actual,
    homedir: () => currentHome,
  };
});

import {
  generateAnswer,
  selectCitedCitations,
  stripStrayAbstainCitations,
  opensWithRefusal,
  hasOnTopicCoverage,
  isHowToHedge,
  compactRenumber,
  buildCitations,
  NO_CONTEXT_ANSWER,
  Chunk,
  Citation,
} from "../src/llm/generate";

describe("generateAnswer", () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeAll(() => {
    currentHome = mkdtempSync(join(tmpdir(), "monday-gen-"));
    process.env.ANTHROPIC_API_KEY = "test-stub-key";
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalEnv;
  });

  test("empty chunks returns no-context answer without citations", async () => {
    const result = await generateAnswer("What is the meaning of life?", []);
    expect(result.answer.toLowerCase()).toMatch(
      /couldn't find|could not find|no relevant|not find|unable to find/,
    );
    expect(result.citations).toEqual([]);
  });

  test("chunks produce an answer plus a citations array keyed by source", async () => {
    const chunks: Chunk[] = [
      {
        id: "c1",
        text: "VPN access requires Cisco AnyConnect.",
        source: "vpn-guide.txt",
        heading: "VPN Setup",
      },
      {
        id: "c2",
        text: "Sign in with your corporate email after installing.",
        source: "vpn-guide.txt",
      },
    ];
    const result = await generateAnswer("How do I set up VPN?", chunks);
    expect(typeof result.answer).toBe("string");
    expect(result.answer.length).toBeGreaterThan(0);
    // The stub answer only cites [1], so under cited-only filtering exactly one
    // citation (number 1) survives — the uncited [2] source is dropped.
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toEqual({
      number: 1,
      source: "vpn-guide.txt",
      heading: "VPN Setup",
    });
  });

  test("passes temperature: 0 to messages.create (determinism wiring, #1195)", async () => {
    // The request object never escapes generateAnswer's return value, so the
    // stub records it for introspection. temperature:0 is the direct lever for
    // the ground-vs-abstain coin-flip.
    const AnthropicStub = require("@anthropic-ai/sdk");
    AnthropicStub.__resetLastRequest();
    const chunks: Chunk[] = [
      { id: "c1", text: "Annual leave is 14 days per year.", source: "hr-policy.txt" },
    ];
    await generateAnswer("How many days of leave?", chunks);
    const req = AnthropicStub.__getLastRequest();
    expect(req).not.toBeNull();
    expect(req.temperature).toBe(0);
  });

  test("stub-provided answer carries a [1] citation marker", async () => {
    const chunks: Chunk[] = [
      {
        id: "c1",
        text: "Annual leave is 14 days per year.",
        source: "hr-policy.txt",
      },
    ];
    const result = await generateAnswer("How many days of leave?", chunks);
    expect(result.answer).toContain("[1]");
  });

  test("rejects non-array chunks defensively by short-circuiting", async () => {
    // Even if a caller passes undefined/null, the function must not call the SDK.
    const result = await generateAnswer(
      "edge case",
      undefined as unknown as Chunk[],
    );
    expect(result.citations).toEqual([]);
    expect(result.answer.toLowerCase()).toMatch(/find/);
  });

  describe("MONDAY_TEST_MODE=1 offline path", () => {
    afterEach(() => {
      delete process.env.MONDAY_TEST_MODE;
    });

    test("returns deterministic offline body without calling the LLM", async () => {
      process.env.MONDAY_TEST_MODE = "1";
      const chunks: Chunk[] = [
        {
          id: "c1",
          text: "Annual leave is 14 days per year.",
          source: "hr-policy.txt",
          heading: "Leave",
        },
      ];
      const result = await generateAnswer("How many days of leave?", chunks);
      // Offline body concatenates chunk text and appends [1].
      expect(result.answer).toContain("Annual leave is 14 days per year.");
      expect(result.answer).toContain("[1]");
      // Citations are still populated from the chunks.
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0]).toEqual({
        number: 1,
        source: "hr-policy.txt",
        heading: "Leave",
      });
    });
  });

  // #1374b — code backstop. Nested here so it inherits the ANTHROPIC_API_KEY
  // beforeAll/afterAll above (R2): without a key, generateAnswer falls to the
  // offline path and never consults the stub (0 model calls -> wrong path).
  describe("over-refusal backstop", () => {
    const AnthropicStub = require("@anthropic-ai/sdk");

    afterEach(() => {
      // R3 leak-prevention: clear the FIFO queue + counter + lastRequest so
      // unconsumed responses can't corrupt the next test's call-count assertion.
      AnthropicStub.__reset();
    });

    const synthChunks: Chunk[] = [
      {
        id: "c1",
        text: "The onboarding flow is set step X then step Y.",
        source: "mb-flow-onboarding",
        heading: "Onboarding",
      },
      {
        id: "c2",
        text: "The widget config lives under settings.",
        source: "mb-feature-widget",
      },
    ];

    test("B1: chunks>0 + refusal opener -> regenerate once, returns grounded retry", async () => {
      AnthropicStub.__reset();
      AnthropicStub.__setResponses([
        "I couldn't find any relevant information about that.",
        "The documented onboarding flow is set X then Y [1].",
      ]);
      const result = await generateAnswer("How does onboarding work?", synthChunks);
      expect(result.answer).toContain("documented onboarding flow");
      expect(result.answer).not.toMatch(/^I couldn't find/);
      expect(result.citations.length).toBeGreaterThanOrEqual(1);
      expect(AnthropicStub.__getCallCount()).toBe(2);
    });

    test("B2: chunks===0 -> refusal, citations [], ZERO model calls", async () => {
      AnthropicStub.__reset();
      const result = await generateAnswer("Anything?", []);
      expect(result.answer.toLowerCase()).toMatch(/couldn't find|no relevant/);
      expect(result.citations).toEqual([]);
      expect(AnthropicStub.__getCallCount()).toBe(0);
    });

    test("B3: two refusals in a row -> still abstains, no fabrication, citations []", async () => {
      AnthropicStub.__reset();
      // Both refusals carry NO [N] markers (N1): the 2nd uses a non-stripStray
      // opener on purpose to prove the marker-free path also yields [].
      AnthropicStub.__setResponses([
        "I couldn't find anything on that topic.",
        "I don't have information addressing that topic.",
      ]);
      const result = await generateAnswer("How does onboarding work?", synthChunks);
      expect(result.answer.toLowerCase()).toMatch(/couldn't find|don't have/);
      expect(result.answer).not.toContain("[1]");
      expect(result.citations).toEqual([]);
      expect(AnthropicStub.__getCallCount()).toBe(2);
    });

    test("B4: MONDAY_REFUSAL_BACKSTOP=0 suppresses the regenerate call", async () => {
      const prev = process.env.MONDAY_REFUSAL_BACKSTOP;
      process.env.MONDAY_REFUSAL_BACKSTOP = "0";
      try {
        AnthropicStub.__reset();
        AnthropicStub.__setResponses([
          "I couldn't find that.",
          "grounded reply [1]",
        ]);
        const result = await generateAnswer("How does onboarding work?", synthChunks);
        expect(AnthropicStub.__getCallCount()).toBe(1);
        expect(result.answer.toLowerCase()).toMatch(/couldn't find/);
      } finally {
        if (prev === undefined) delete process.env.MONDAY_REFUSAL_BACKSTOP;
        else process.env.MONDAY_REFUSAL_BACKSTOP = prev;
      }
    });

    test("B5: opensWithRefusal detector + override + curly apostrophe", () => {
      const prev = process.env.MONDAY_REFUSAL_OPENERS;
      try {
        // Default openers detected.
        expect(opensWithRefusal("I couldn't find that.")).toBe(true);
        expect(opensWithRefusal("I could not find that.")).toBe(true);
        expect(opensWithRefusal("I don't have that.")).toBe(true);
        expect(opensWithRefusal("No relevant information here.")).toBe(true);
        // N2: typographic/curly apostrophe form matches.
        expect(opensWithRefusal("I couldn’t find that.")).toBe(true);
        // Leading whitespace tolerated.
        expect(opensWithRefusal("   I couldn't find that.")).toBe(true);
        // Content-leading answer is NOT a refusal.
        expect(opensWithRefusal("The setup doc [1] covers that.")).toBe(false);
        // Non-string -> false.
        expect(opensWithRefusal(undefined as unknown as string)).toBe(false);

        // Override: a custom phrase is detected AND a former default is not.
        process.env.MONDAY_REFUSAL_OPENERS = "Regrettably, no data";
        expect(opensWithRefusal("Regrettably, no data exists.")).toBe(true);
        expect(opensWithRefusal("I couldn't find that.")).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.MONDAY_REFUSAL_OPENERS;
        else process.env.MONDAY_REFUSAL_OPENERS = prev;
      }
    });
  });

  // #1380 — how-to over-refusal backstop (SECOND refusal class, coverage-gated).
  // Nested here so it inherits the ANTHROPIC_API_KEY beforeAll/afterAll (without
  // a key generateAnswer falls to the offline path and never consults the stub).
  describe("how-to over-refusal backstop", () => {
    const AnthropicStub = require("@anthropic-ai/sdk");

    afterEach(() => {
      AnthropicStub.__reset();
    });

    // High-score on-topic chunks: best chunk >= the 0.35 measured floor, so
    // hasOnTopicCoverage is TRUE (coverage present).
    const onTopicChunks: Chunk[] = [
      {
        id: "c1",
        text: "The matching flow selects the nearest available slot then confirms.",
        source: "mb-flow-overview",
        heading: "Flow Overview",
        score: 0.57,
      },
      {
        id: "c2",
        text: "The selection rules describe how a candidate is chosen.",
        source: "mb-flow-overview",
        score: 0.41,
      },
    ];

    // All scores BELOW the floor: hasOnTopicCoverage is FALSE (no coverage).
    const offTopicChunks: Chunk[] = [
      { id: "d1", text: "Unrelated note about billing exports.", source: "mb-misc", score: 0.2 },
      { id: "d2", text: "Another off-topic stub.", source: "mb-misc-2", score: 0.18 },
    ];

    const HEDGE =
      "Here is what the docs cover, but these describe internal specs, not user-facing steps.";

    test("H1 (POSITIVE): coverage + uncited how-to hedge -> regenerate once, grounded steps", async () => {
      AnthropicStub.__reset();
      AnthropicStub.__setResponses([
        HEDGE,
        "Step 1: open the finder. Step 2: pick the nearest slot. Step 3: confirm [1].",
      ]);
      const result = await generateAnswer("How do I find an available slot?", onTopicChunks);
      expect(result.answer).toContain("Step 1");
      expect(result.answer).not.toContain("not user-facing steps");
      expect(result.citations.length).toBeGreaterThanOrEqual(1);
      expect(AnthropicStub.__getCallCount()).toBe(2);
    });

    test("H2 (NEGATIVE, coverage gate): low-score chunks + hedge -> still abstains, ZERO regenerate", async () => {
      AnthropicStub.__reset();
      AnthropicStub.__setResponses([HEDGE]);
      const result = await generateAnswer("How do I find an available slot?", offTopicChunks);
      // hasOnTopicCoverage is false -> howToClass never fires -> no 2nd call.
      expect(AnthropicStub.__getCallCount()).toBe(1);
      expect(result.citations).toEqual([]);
      expect(result.answer).toContain("not user-facing steps");
    });

    test("H3 (NEGATIVE, second hedge -> no fabrication): both responses hedge", async () => {
      AnthropicStub.__reset();
      AnthropicStub.__setResponses([
        HEDGE,
        "Still just backend/internal specs here, no user-facing walkthrough.",
      ]);
      const result = await generateAnswer("How do I find an available slot?", onTopicChunks);
      expect(AnthropicStub.__getCallCount()).toBe(2);
      expect(result.answer).not.toMatch(/\[\d+\]/);
      expect(result.citations).toEqual([]);
    });

    test("H4 (no false regenerate on a GROUNDED answer): cited hedge phrase is not a hedge", async () => {
      AnthropicStub.__reset();
      AnthropicStub.__setResponses([
        "The documented process [1] is to pick the nearest slot, rather than a tap-by-tap walkthrough.",
      ]);
      const result = await generateAnswer("How do I find an available slot?", onTopicChunks);
      expect(AnthropicStub.__getCallCount()).toBe(1);
      expect(result.answer).toContain("[1]");
      expect(result.citations.length).toBeGreaterThanOrEqual(1);
    });

    test("H5 (kill-switch): MONDAY_HOWTO_BACKSTOP=0 suppresses the how-to regenerate", async () => {
      const prev = process.env.MONDAY_HOWTO_BACKSTOP;
      process.env.MONDAY_HOWTO_BACKSTOP = "0";
      try {
        AnthropicStub.__reset();
        AnthropicStub.__setResponses([HEDGE, "grounded steps [1]"]);
        const result = await generateAnswer("How do I find an available slot?", onTopicChunks);
        expect(AnthropicStub.__getCallCount()).toBe(1);
        expect(result.answer).toContain("not user-facing steps");
      } finally {
        if (prev === undefined) delete process.env.MONDAY_HOWTO_BACKSTOP;
        else process.env.MONDAY_HOWTO_BACKSTOP = prev;
      }
    });

    test("H6 (detector units): hasOnTopicCoverage + isHowToHedge with overrides", () => {
      // hasOnTopicCoverage — true when a score >= floor, false when all below.
      expect(hasOnTopicCoverage(onTopicChunks)).toBe(true);
      expect(hasOnTopicCoverage(offTopicChunks)).toBe(false);
      // Back-compat: no numeric scores at all -> "unknown, not blocked" -> true.
      expect(
        hasOnTopicCoverage([{ id: "x", text: "t", source: "s" }]),
      ).toBe(true);
      // Honors the coverage-floor override.
      const prevFloor = process.env.MONDAY_HOWTO_COVERAGE_MIN_SCORE;
      try {
        process.env.MONDAY_HOWTO_COVERAGE_MIN_SCORE = "0.9";
        expect(hasOnTopicCoverage(onTopicChunks)).toBe(false); // 0.57 < 0.9
        process.env.MONDAY_HOWTO_COVERAGE_MIN_SCORE = "0.1";
        expect(hasOnTopicCoverage(offTopicChunks)).toBe(true); // 0.2 >= 0.1
      } finally {
        if (prevFloor === undefined) delete process.env.MONDAY_HOWTO_COVERAGE_MIN_SCORE;
        else process.env.MONDAY_HOWTO_COVERAGE_MIN_SCORE = prevFloor;
      }

      // isHowToHedge — true on uncited hedge, false when same phrase is cited,
      // false on a clean grounded answer.
      expect(isHowToHedge("these are internal specs, not user-facing steps")).toBe(true);
      expect(isHowToHedge("the documented flow [1] is not user-facing steps")).toBe(false);
      expect(isHowToHedge("Step 1: open the finder. Step 2: confirm.")).toBe(false);
      // Honors the hedge-phrase override (custom detected, a former default not).
      const prevPhrases = process.env.MONDAY_HOWTO_HEDGE_PHRASES;
      try {
        process.env.MONDAY_HOWTO_HEDGE_PHRASES = "regrettably no walkthrough";
        expect(isHowToHedge("Regrettably no walkthrough exists.")).toBe(true);
        expect(isHowToHedge("these are not user-facing steps")).toBe(false);
      } finally {
        if (prevPhrases === undefined) delete process.env.MONDAY_HOWTO_HEDGE_PHRASES;
        else process.env.MONDAY_HOWTO_HEDGE_PHRASES = prevPhrases;
      }
    });

    test("H7 (CLASS PRECEDENCE): opener AND hedge co-occur -> #1374 directive wins", async () => {
      AnthropicStub.__reset();
      AnthropicStub.__setResponses([
        "I couldn't find a step-by-step guide; the docs are backend/internal specs, not user-facing steps.",
        "The documented flow [1] is to pick the nearest slot.",
      ]);
      const result = await generateAnswer("How do I find an available slot?", onTopicChunks);
      expect(AnthropicStub.__getCallCount()).toBe(2);
      // The 2nd (regenerate) call must carry the #1374 REGEN_DIRECTIVE, NOT the
      // how-to directive — refusalClass takes precedence.
      const req = AnthropicStub.__getLastRequest();
      const sent: string = req.messages[0].content;
      expect(sent).toContain("even though the product/feature NAME may be absent");
      expect(sent).not.toContain("SYNTHESIZE the user-facing steps");
      expect(result.answer).toContain("[1]");
    });
  });

  // #1375 — dedup by source + compact renumber. Nested per R2 for the C2
  // generateAnswer path; pure-function cases (C1, C3-C5) need no key.
  describe("citation dedup + renumber", () => {
    const AnthropicStub = require("@anthropic-ai/sdk");

    afterEach(() => {
      AnthropicStub.__reset();
    });

    test("C1: buildCitations returns ONE citation per unique source", () => {
      const chunks: Chunk[] = [
        { id: "a", text: "onboarding part 1", source: "mb-flow-onboarding", heading: "Onboarding" },
        { id: "b", text: "onboarding part 2", source: "mb-flow-onboarding" },
        { id: "c", text: "widget cfg", source: "mb-feature-widget" },
      ];
      const cites = buildCitations(chunks);
      expect(cites).toEqual([
        { number: 1, source: "mb-flow-onboarding", heading: "Onboarding" },
        { number: 2, source: "mb-feature-widget" },
      ]);
    });

    test("C2: one source over two cited positions -> ONE number, contiguous", async () => {
      AnthropicStub.__reset();
      // N3: enqueue-stub path (NOT MONDAY_TEST_MODE). Stub cites BOTH [1] and [2].
      AnthropicStub.__setResponses([
        "The onboarding flow is documented [1] and the widget config too [2].",
      ]);
      const chunks: Chunk[] = [
        { id: "a", text: "onboarding part 1", source: "mb-flow-onboarding", heading: "Onboarding" },
        { id: "b", text: "onboarding part 2", source: "mb-flow-onboarding" },
        { id: "c", text: "widget cfg", source: "mb-feature-widget" },
      ];
      const result = await generateAnswer("How does onboarding work?", chunks);
      const onboardingCount = result.citations.filter(
        (c) => c.source === "mb-flow-onboarding",
      ).length;
      expect(onboardingCount).toBe(1);
      const numbers = result.citations.map((c) => c.number).sort((x, y) => x - y);
      expect(numbers).toEqual([1, 2]);
      // Answer text markers match the citation numbers.
      for (const c of result.citations) {
        expect(result.answer).toContain(`[${c.number}]`);
      }
    });

    test("C3: compactRenumber rewrites non-contiguous -> contiguous, text + list", () => {
      const result = compactRenumber("See [2] and then [4].", [
        { number: 2, source: "mb-feature-widget" },
        { number: 4, source: "mb-flow-onboarding" },
      ]);
      expect(result.answer).toBe("See [1] and then [2].");
      expect(result.citations).toEqual([
        { number: 1, source: "mb-feature-widget" },
        { number: 2, source: "mb-flow-onboarding" },
      ]);
    });

    test("C4: compactRenumber is multi-digit safe ([1] and [10] -> [1] and [2])", () => {
      const citations: Citation[] = [];
      for (let i = 1; i <= 10; i++) citations.push({ number: i, source: `s${i}` });
      const result = compactRenumber("First [1] then last [10].", citations);
      expect(result.answer).toBe("First [1] then last [2].");
      expect(result.citations).toEqual([
        { number: 1, source: "s1" },
        { number: 2, source: "s10" },
      ]);
    });

    test("C5: compactRenumber no-op on an abstain (empty citations)", () => {
      const result = compactRenumber("I couldn't find it.", []);
      expect(result.answer).toBe("I couldn't find it.");
      expect(result.citations).toEqual([]);
    });
  });
});

describe("selectCitedCitations", () => {
  const five: Citation[] = [
    { number: 1, source: "a.txt" },
    { number: 2, source: "b.txt" },
    { number: 3, source: "c.txt" },
    { number: 4, source: "d.txt" },
    { number: 5, source: "e.txt" },
  ];

  test("returns only the cited citations, original numbers and order", () => {
    const result = selectCitedCitations("Foo [2] and bar [4].", five);
    expect(result).toEqual([
      { number: 2, source: "b.txt" },
      { number: 4, source: "d.txt" },
    ]);
  });

  test("returns [] when the answer has no [N] markers", () => {
    expect(selectCitedCitations("I could not find it.", five)).toEqual([]);
  });

  test("returns [] for the NO_CONTEXT_ANSWER sentinel", () => {
    expect(selectCitedCitations(NO_CONTEXT_ANSWER, five)).toEqual([]);
  });

  test("dedupes duplicate markers to a single citation", () => {
    const result = selectCitedCitations("See [2] ... and again [2].", five);
    expect(result).toEqual([{ number: 2, source: "b.txt" }]);
  });

  test("drops out-of-range markers", () => {
    const result = selectCitedCitations("Refers to [9] only.", five);
    expect(result).toEqual([]);
  });

  test("defensive: non-string answer or non-array citations -> []", () => {
    expect(
      selectCitedCitations(undefined as unknown as string, five),
    ).toEqual([]);
    expect(
      selectCitedCitations("Foo [1].", undefined as unknown as Citation[]),
    ).toEqual([]);
  });
});

describe("stripStrayAbstainCitations", () => {
  const cites: Citation[] = [
    { number: 1, source: "doc-a" },
    { number: 2, source: "doc-b" },
  ];

  test("A: abstain opener with a stray [1] -> marker stripped, citations emptied", () => {
    const result = stripStrayAbstainCitations(
      "I couldn't find a separate guide for the asked topic [1].",
      [cites[0]],
    );
    expect(result.answer).toBe(
      "I couldn't find a separate guide for the asked topic.",
    );
    expect(result.answer).not.toContain("[1]");
    expect(result.citations).toEqual([]);
  });

  test("A2: typographic-apostrophe opener with a stray [2] is also stripped", () => {
    const result = stripStrayAbstainCitations(
      "I couldn’t find anything on the asked topic [2].",
      [cites[1]],
    );
    expect(result.answer).not.toContain("[2]");
    expect(result.citations).toEqual([]);
  });

  test("B: grounded answer that leads with content and notes a gap later is UNCHANGED", () => {
    const answer =
      "The setup doc [1] covers the asked topic; I couldn't find a separate deep-dive [2].";
    const result = stripStrayAbstainCitations(answer, cites);
    expect(result.answer).toBe(answer);
    expect(result.answer).toContain("[1]");
    expect(result.answer).toContain("[2]");
    expect(result.citations).toBe(cites);
  });

  test("C: canonical NO_CONTEXT_ANSWER is returned unchanged and clean", () => {
    const result = stripStrayAbstainCitations(NO_CONTEXT_ANSWER, []);
    expect(result.answer).toBe(NO_CONTEXT_ANSWER);
    expect(result.citations).toEqual([]);
  });

  test("D(i): non-string answer does not throw and is returned as-is", () => {
    const result = stripStrayAbstainCitations(
      undefined as unknown as string,
      cites,
    );
    expect(result.answer).toBeUndefined();
    expect(result.citations).toBe(cites);
  });

  test("D(ii): non-array citations on the abstain branch -> stripped + []", () => {
    const result = stripStrayAbstainCitations(
      "I couldn't find it [1].",
      undefined as unknown as Citation[],
    );
    expect(result.answer).not.toContain("[1]");
    expect(result.citations).toEqual([]);
  });

  test("E: spacing tidy contract -> no double spaces, no space before period", () => {
    const result = stripStrayAbstainCitations(
      "I couldn't find  [1]  the asked topic [2] here.",
      cites,
    );
    expect(result.answer).toBe("I couldn't find the asked topic here.");
    expect(result.citations).toEqual([]);
  });
});
