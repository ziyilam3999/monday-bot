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

  it("leaves single-word `__bold__` literal (accepted v1 miss — #1190 identifier-skip can't tell a dunder from a 1-word bold; the LLM emits `**bold**` for this)", () => {
    expect(markdownToMrkdwn("__bold__")).toBe("__bold__");
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

  // ---- #1190 edge cases ----
  // NEW-BEHAVIOR (these FAIL on current master, PASS after the 3-star rule +
  // the __identifier__ skip land).
  describe("#1190 new-behavior (red on master, green after)", () => {
    it("collapses `***bold italic***` to single-asterisk bold", () => {
      expect(markdownToMrkdwn("***bold italic***")).toBe("*bold italic*");
    });

    it("fixes a bold ATX heading `# **Title**` -> `*Title*`", () => {
      expect(markdownToMrkdwn("# **Title**")).toBe("*Title*");
    });

    it("fixes a multi-word bold heading `## **Multi Word**` -> `*Multi Word*`", () => {
      expect(markdownToMrkdwn("## **Multi Word**")).toBe("*Multi Word*");
    });

    it("locks 3-star-before-2-star on a shared line: `mix ***bi*** and **b**`", () => {
      expect(markdownToMrkdwn("mix ***bi*** and **b**")).toBe("mix *bi* and *b*");
    });

    it("leaves a Python dunder `__init__` literal", () => {
      expect(markdownToMrkdwn("__init__")).toBe("__init__");
    });

    it("leaves a method call `obj.__init__()` literal", () => {
      expect(markdownToMrkdwn("obj.__init__()")).toBe("obj.__init__()");
    });

    it("leaves `__name__` literal", () => {
      expect(markdownToMrkdwn("__name__")).toBe("__name__");
    });

    it("leaves intraword underscores `a__b__c` intact", () => {
      expect(markdownToMrkdwn("a__b__c")).toBe("a__b__c");
    });

    it("leaves intraword underscores `snake__case__x` intact", () => {
      expect(markdownToMrkdwn("snake__case__x")).toBe("snake__case__x");
    });
  });

  // REGRESSION-GUARD: these already PASS on master; keep them green. They do NOT
  // assert "differs from master" — the multi-word `__` path was never the bug.
  describe("#1190 regression-guard (already green on master)", () => {
    it("still converts multi-word `__very important__` -> `*very important*`", () => {
      expect(markdownToMrkdwn("__very important__")).toBe("*very important*");
    });

    it("still converts `**bold**` -> `*bold*`", () => {
      expect(markdownToMrkdwn("**bold**")).toBe("*bold*");
    });

    it("still converts heading `# Heading` -> `*Heading*`", () => {
      expect(markdownToMrkdwn("# Heading")).toBe("*Heading*");
    });

    it("still converts bullet `- item` -> `• item`", () => {
      expect(markdownToMrkdwn("- item")).toBe("• item");
    });

    it("still converts link `[text](url)` -> `<url|text>`", () => {
      expect(markdownToMrkdwn("[text](http://x)")).toBe("<http://x|text>");
    });

    it("still leaves a `[2]` citation untouched", () => {
      expect(markdownToMrkdwn("see note [2] for details")).toBe(
        "see note [2] for details"
      );
    });

    it("still converts `**a** and **b**` -> `*a* and *b*` independently", () => {
      expect(markdownToMrkdwn("**a** and **b**")).toBe("*a* and *b*");
    });
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
