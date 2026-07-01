/**
 * Unit tests for `formatAskDefectsBlocks` (#1386) — the PURE formatter that
 * renders a label-aware `/ask` answer's tagged defects as APPENDED blocks. It must
 * NEVER emit a `[N]` citation marker (citation-safety) and must honour the
 * `ASK_DEFECTS_MAX` cap with a `…and N more` overflow affordance.
 */
import { formatAskDefectsBlocks, SlackSectionBlock } from "../src/slack/formatter";

const CITATION_MARKER = /\[\d+\]/;

function sectionText(blocks: ReturnType<typeof formatAskDefectsBlocks>): string {
  const section = blocks.find((b) => b.type === "section") as SlackSectionBlock | undefined;
  return section?.text.text ?? "";
}

describe("formatAskDefectsBlocks (#1386)", () => {
  it("empty issues ⇒ []", () => {
    expect(formatAskDefectsBlocks({ issues: [] })).toEqual([]);
  });

  it("missing issues / null reply ⇒ []", () => {
    expect(formatAskDefectsBlocks({})).toEqual([]);
    expect(formatAskDefectsBlocks(null)).toEqual([]);
    expect(formatAskDefectsBlocks(undefined)).toEqual([]);
  });

  it("one+ issues ⇒ [divider, section] with a defects header + bullet, no [N] marker", () => {
    const blocks = formatAskDefectsBlocks({
      issues: [{ key: "DEMO-1", summary: "synthetic crash" }],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "divider" });
    const text = sectionText(blocks);
    expect(text).toContain("Related tracked defects");
    expect(text).toContain("• DEMO-1 — synthetic crash");
    expect(text).not.toMatch(CITATION_MARKER);
  });

  it("omits the ' — summary' when a summary is absent", () => {
    const text = sectionText(formatAskDefectsBlocks({ issues: [{ key: "DEMO-2" }] }));
    expect(text).toContain("• DEMO-2");
    expect(text).not.toContain("— ");
  });

  it("sanitizeTitle strips stray *, ~ and backtick from key + summary", () => {
    const text = sectionText(
      formatAskDefectsBlocks({ issues: [{ key: "DE*MO-3", summary: "a ~bad~ `title`" }] }),
    );
    expect(text).toContain("• DEMO-3 — a bad title");
    // The bullet line itself carries no stray emphasis chars (the `*Related…*`
    // header legitimately uses `*` for bold, so scope the check to the bullet).
    const bullet = text.split("\n").find((l) => l.startsWith("• "))!;
    expect(bullet).not.toMatch(/[*~`]/);
  });

  it("cap + overflow affordance: 8 issues, max=3 ⇒ 3 bullets + '…and 5 more'", () => {
    const issues = Array.from({ length: 8 }, (_v, i) => ({
      key: `DEMO-${i + 1}`,
      summary: `issue ${i + 1}`,
    }));
    const text = sectionText(formatAskDefectsBlocks({ issues }, 3));
    const bullets = text.split("\n").filter((l) => l.startsWith("• "));
    expect(bullets).toHaveLength(3);
    expect(text).toContain("…and 5 more");
  });

  it("no overflow line when max >= count", () => {
    const issues = [
      { key: "DEMO-1", summary: "a" },
      { key: "DEMO-2", summary: "b" },
    ];
    const text = sectionText(formatAskDefectsBlocks({ issues }, 5));
    const bullets = text.split("\n").filter((l) => l.startsWith("• "));
    expect(bullets).toHaveLength(2);
    expect(text).not.toContain("more");
  });
});
