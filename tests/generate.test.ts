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
