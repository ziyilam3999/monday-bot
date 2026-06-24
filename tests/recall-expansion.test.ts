import {
  expandQuery,
  hasGeoIntent,
  GEO_INTENT_SIGNALS,
} from "../src/knowledge/queryExpansion";

/**
 * A1 — Lever 1 (query expansion) logic units (#1191).
 *
 * RED today: the function is absent. GREEN: geo-intent questions gain
 * launch/market synonyms; non-geo questions are returned BYTE-UNCHANGED.
 */
describe("expandQuery (Lever 1)", () => {
  it("AC1: geo-intent question gains launch/market synonyms", () => {
    const out = expandQuery("which places have the service available", { enabled: true });
    expect(out).not.toBe("which places have the service available");
    for (const term of ["markets", "regions", "coverage", "launch"]) {
      expect(out.toLowerCase()).toContain(term);
    }
    // Original question text is preserved verbatim at the front.
    expect(out.startsWith("which places have the service available")).toBe(true);
  });

  it("AC1: a non-geo question is returned UNCHANGED (no over-trigger)", () => {
    const q = "how do I reset my password";
    expect(expandQuery(q, { enabled: true })).toBe(q);
  });

  it("a non-geo question with generic words (service/open) is NOT expanded (correction #3)", () => {
    // `service` and `open` are deliberately EXCLUDED from the signal set so
    // these do NOT trigger expansion.
    expect(expandQuery("is the printer service open", { enabled: true })).toBe(
      "is the printer service open",
    );
    expect(expandQuery("when does the office open", { enabled: true })).toBe(
      "when does the office open",
    );
  });

  it("disabled config is an identity function", () => {
    const q = "which places have the service available";
    expect(expandQuery(q, { enabled: false })).toBe(q);
  });

  it("dedups synonyms already present in the question", () => {
    const out = expandQuery("which markets and regions have coverage", { enabled: true });
    // 'markets', 'regions', 'coverage' already present → not duplicated.
    expect(out.match(/\bmarkets\b/g)?.length).toBe(1);
    expect(out.match(/\bregions\b/g)?.length).toBe(1);
    expect(out.match(/\bcoverage\b/g)?.length).toBe(1);
  });

  it("hasGeoIntent matches the closed signal set and nothing generic", () => {
    expect(hasGeoIntent("where is it available")).toBe(true);
    expect(hasGeoIntent("which regions launched")).toBe(true);
    expect(hasGeoIntent("reset my password please")).toBe(false);
    expect(hasGeoIntent("restart the service")).toBe(false); // 'service' excluded
    // Closed set must not contain the over-generic tokens.
    for (const generic of ["service", "services", "open", "support", "supported"]) {
      expect(GEO_INTENT_SIGNALS.has(generic)).toBe(false);
    }
  });
});
