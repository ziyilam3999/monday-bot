import { formatAnswer, markdownToMrkdwn } from "../src/slack/formatter";

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

  it("sanitizes stray markdown in the source/heading title", () => {
    const payload = formatAnswer({
      answer: "See the doc. [1]",
      citations: [{ num: 1, source: "**Important** Guide", heading: "`code`" }],
    });
    const ctx = payload.blocks.find((b) => b.type === "context");
    expect(ctx).toBeDefined();
    if (ctx && ctx.type === "context") {
      const text = ctx.elements[0].text;
      expect(text).not.toContain("**");
      expect(text).not.toContain("`");
      // Sanitized visible words survive.
      expect(text).toContain("Important");
      expect(text).toContain("Guide");
      expect(text).toContain("code");
    }
  });

  it("throws TypeError on bad input", () => {
    expect(() => formatAnswer(undefined as never)).toThrow(TypeError);
    expect(() => formatAnswer({ answer: 123 as never })).toThrow(TypeError);
  });
});

describe("markdownToMrkdwn", () => {
  it("converts `**bold:**` to a single-asterisk bold and leaves no `**`", () => {
    const out = markdownToMrkdwn("**Daily Borrowing Limit:**");
    expect(out).toBe("*Daily Borrowing Limit:*");
    expect(out).not.toContain("**");
  });

  it("converts multiple bold spans independently (non-greedy)", () => {
    // A greedy match would swallow the middle " and " into one span.
    expect(markdownToMrkdwn("**a** and **b**")).toBe("*a* and *b*");
  });

  it("converts `__bold__` to single-asterisk bold", () => {
    expect(markdownToMrkdwn("__bold__")).toBe("*bold*");
  });

  it("converts an ATX heading line to bold", () => {
    expect(markdownToMrkdwn("# Title")).toBe("*Title*");
  });

  it("converts a Markdown link to Slack link syntax", () => {
    expect(markdownToMrkdwn("[text](http://x)")).toBe("<http://x|text>");
  });

  it("converts a `- ` bullet line to a `• ` bullet", () => {
    expect(markdownToMrkdwn("- item")).toBe("• item");
  });

  it("converts a `* ` bullet line to a `• ` bullet", () => {
    expect(markdownToMrkdwn("* item")).toBe("• item");
  });

  it("leaves a bare citation token `[2]` untouched (no parens -> not a link)", () => {
    expect(markdownToMrkdwn("see note [2] for details")).toBe(
      "see note [2] for details"
    );
  });

  it("leaves single `_italic_` untouched (already valid Slack italic)", () => {
    expect(markdownToMrkdwn("_italic_")).toBe("_italic_");
  });

  it("leaves single `*italic*` untouched (accepted v1 cosmetic miss)", () => {
    expect(markdownToMrkdwn("*italic*")).toBe("*italic*");
  });

  it("leaves `~strike~` and plain text untouched", () => {
    expect(markdownToMrkdwn("plain ~strike~ text")).toBe("plain ~strike~ text");
  });

  it("documented v1 limitation: does NOT mask code spans, so `**` inside a `code` span IS converted", () => {
    // The converter has no code-span protection in v1 — this asserts the
    // CURRENT behavior explicitly rather than leaving the gap silent.
    expect(markdownToMrkdwn("`a**b**c`")).toBe("`a*b*c`");
  });

  it("behavioral both-ends: a multi-paragraph `**bold:**` answer's section text contains no `**`", () => {
    const answer = [
      "**Overview:** This is the summary line.",
      "",
      "**Steps:**",
      "- First do the thing.",
      "- Then do the **other** thing.",
      "",
      "See the [guide](http://example.test/guide) for more. [1]",
    ].join("\n");
    const payload = formatAnswer({
      answer,
      citations: [{ num: 1, source: "guide.md" }],
    });
    const section = payload.blocks.find((b) => b.type === "section");
    expect(section).toBeDefined();
    if (section && section.type === "section") {
      expect(section.text.text).not.toContain("**");
      expect(section.text.text).toContain("*Overview:*");
      expect(section.text.text).toContain("• First do the thing.");
      expect(section.text.text).toContain("<http://example.test/guide|guide>");
    }
    // The fallback text uses the same converted string.
    expect(payload.text).not.toContain("**");
  });
});
