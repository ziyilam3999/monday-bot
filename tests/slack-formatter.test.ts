import { formatAnswer } from "../src/slack/formatter";

describe("slack/formatter", () => {
  it("produces a section block with the answer text", () => {
    const payload = formatAnswer({
      answer: "Annual leave is 14 days. [1]",
      citations: [{ num: 1, source: "hr-policy.txt" }],
    });
    expect(Array.isArray(payload.blocks)).toBe(true);
    expect(payload.blocks.length).toBeGreaterThan(0);
    const section = payload.blocks.find((b) => b.type === "section");
    expect(section).toBeDefined();
    if (section && section.type === "section") {
      expect(section.text.text).toContain("Annual leave is 14 days");
    }
  });

  it("includes citation source in a context block", () => {
    const payload = formatAnswer({
      answer: "Use Cisco AnyConnect. [1]",
      citations: [{ num: 1, source: "vpn-guide.txt" }],
    });
    const text = JSON.stringify(payload);
    expect(text).toContain("vpn-guide.txt");
    const ctx = payload.blocks.find((b) => b.type === "context");
    expect(ctx).toBeDefined();
    if (ctx && ctx.type === "context") {
      expect(ctx.elements.length).toBe(1);
      expect(ctx.elements[0].text).toContain("vpn-guide.txt");
      expect(ctx.elements[0].text).toContain("[1]");
    }
  });

  it("accepts the canonical Citation shape with `number` instead of `num`", () => {
    const payload = formatAnswer({
      answer: "WFH policy is two days a week. [1]",
      citations: [{ number: 1, source: "wfh.md" }],
    });
    const text = JSON.stringify(payload);
    expect(text).toContain("wfh.md");
    expect(text).toContain("[1]");
  });

  it("renders heading next to the citation source when provided", () => {
    const payload = formatAnswer({
      answer: "See the doc. [1]",
      citations: [{ num: 1, source: "guide.md", heading: "Setup" }],
    });
    const text = JSON.stringify(payload);
    expect(text).toContain("Setup");
    expect(text).toContain("guide.md");
  });

  it("omits the divider and context block when there are no citations", () => {
    const payload = formatAnswer({ answer: "I do not know." });
    expect(payload.blocks.find((b) => b.type === "divider")).toBeUndefined();
    expect(payload.blocks.find((b) => b.type === "context")).toBeUndefined();
    expect(payload.blocks.length).toBe(1);
  });

  it("provides a top-level fallback `text` field for notifications", () => {
    const payload = formatAnswer({
      answer: "Annual leave is 14 days. [1]",
      citations: [{ num: 1, source: "hr-policy.txt" }],
    });
    expect(typeof payload.text).toBe("string");
    expect(payload.text.length).toBeGreaterThan(0);
    expect(payload.text).toContain("Annual leave");
  });

  it("chunks long citation lists into multiple context blocks (10 per block)", () => {
    const citations = Array.from({ length: 23 }, (_, i) => ({
      num: i + 1,
      source: `doc-${i + 1}.txt`,
    }));
    const payload = formatAnswer({ answer: "Many sources. [1]..[23]", citations });
    const ctxBlocks = payload.blocks.filter((b) => b.type === "context");
    expect(ctxBlocks.length).toBe(3); // 10 + 10 + 3
  });

  it("truncates extremely long answers to stay under Slack's section text cap", () => {
    const longAnswer = "x".repeat(5000);
    const payload = formatAnswer({ answer: longAnswer });
    const section = payload.blocks.find((b) => b.type === "section");
    expect(section).toBeDefined();
    if (section && section.type === "section") {
      expect(section.text.text.length).toBeLessThanOrEqual(2900);
    }
  });

  it("throws TypeError on bad input", () => {
    expect(() => formatAnswer(undefined as never)).toThrow(TypeError);
    expect(() => formatAnswer({ answer: 123 as never })).toThrow(TypeError);
  });
});
