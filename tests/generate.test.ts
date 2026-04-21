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

import { generateAnswer, Chunk } from "../src/llm/generate";

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
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]).toEqual({
      number: 1,
      source: "vpn-guide.txt",
      heading: "VPN Setup",
    });
    expect(result.citations[1]).toEqual({ number: 2, source: "vpn-guide.txt" });
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
});
