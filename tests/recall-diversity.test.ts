import { applyDiversityCap, sourceType } from "../src/knowledge/diversity";

/**
 * A1 — Lever 3 (diversity cap) logic units (#1191).
 * RED today: functions absent.
 */

interface Row {
  source: string;
  id: string;
}

function rows(prefix: string, type: string, n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    source: `${type}:${prefix}-${i}`,
    id: `${type}-${i}`,
  }));
}

describe("sourceType", () => {
  it("AC: maps scheme prefixes and abs paths", () => {
    expect(sourceType("confluence:page-1")).toBe("confluence");
    expect(sourceType("jira:ISSUE-1")).toBe("jira");
    expect(sourceType("/abs/path/file.md")).toBe("local-file");
    expect(sourceType("")).toBe("local-file");
    // A path containing a colon is still classed local-file (leading-slash wins).
    expect(sourceType("/abs/weird:name.md")).toBe("local-file");
  });
});

describe("applyDiversityCap (Lever 3)", () => {
  it("AC2: caps one source-type and back-fills to topK when diversity is available", () => {
    // 20 jira + 6 confluence: with cap=6 there ARE enough non-jira rows for the
    // cap to genuinely bind (6 jira + 6 confluence = 12).
    const input = [...rows("J", "jira", 20), ...rows("C", "confluence", 6)];
    const out = applyDiversityCap(input, 12, { enabled: true, maxPerSourceType: 6 });

    const jiraCount = out.filter((r) => sourceType(r.source) === "jira").length;
    expect(jiraCount).toBeLessThanOrEqual(6);
    expect(out.length).toBe(12);
  });

  it("never STARVES: a thin corpus reaches min(topK, pool) even if that forces a type over the cap", () => {
    // Only 2 confluence available → cannot keep jira <= 6 AND reach 12; back-fill
    // tops up with jira so we return 12 rather than starving at 8.
    const input = [...rows("J", "jira", 20), ...rows("C", "confluence", 2)];
    const out = applyDiversityCap(input, 12, { enabled: true, maxPerSourceType: 6 });
    expect(out.length).toBe(12); // never fewer than min(topK, pool)
    // First-6-jira respect the cap before any forced back-fill.
    const firstJiraBlock = out.filter((r) => sourceType(r.source) === "jira");
    expect(firstJiraBlock.length).toBeGreaterThan(6); // forced overflow proves "never starve"
  });

  it("homogeneous (single source-type) corpus returns the identical rank-ordered top-K (no-op)", () => {
    const input = rows("J", "jira", 10);
    const out = applyDiversityCap(input, 12, { enabled: true, maxPerSourceType: 6 });
    // 10 < topK → returns all 10 in original rank order (reshuffle, never starve).
    expect(out).toEqual(input);
  });

  it("disabled cap is a plain slice(0, topK) — byte-identical to no-cap", () => {
    const input = [...rows("J", "jira", 20), ...rows("C", "confluence", 6)];
    const out = applyDiversityCap(input, 12, { enabled: false });
    expect(out).toEqual(input.slice(0, 12));
  });
});
