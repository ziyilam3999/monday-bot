import {
  assertCatalogReviewed,
  CatalogNotReviewedError,
} from "../src/catalog/reviewedGate";

/**
 * #1343 nit 3 — production actions (real-data eval `--real`, live `--apply`
 * backfill) must REFUSE to run unless the loaded catalog's `reviewed` flag is
 * set. Fail-closed safety gate; synthetic-only.
 */

describe("nit 3 — catalog reviewed gate (production actions fail closed)", () => {
  it("passes when reviewed === true", () => {
    expect(() => assertCatalogReviewed({ reviewed: true }, "feature-flow-eval --real")).not.toThrow();
  });

  it("REFUSES (throws) when reviewed === false", () => {
    expect(() =>
      assertCatalogReviewed({ reviewed: false }, "backfill-namespaced-labels --apply"),
    ).toThrow(CatalogNotReviewedError);
  });

  it("REFUSES when the reviewed flag is absent", () => {
    expect(() => assertCatalogReviewed({}, "feature-flow-eval --real")).toThrow(
      CatalogNotReviewedError,
    );
  });

  it("REFUSES on null / undefined catalog", () => {
    expect(() => assertCatalogReviewed(null, "x")).toThrow(CatalogNotReviewedError);
    expect(() => assertCatalogReviewed(undefined, "x")).toThrow(CatalogNotReviewedError);
  });

  it("carries the action name and never leaks catalog vocabulary in the message", () => {
    try {
      assertCatalogReviewed({ reviewed: false }, "backfill-namespaced-labels --apply");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogNotReviewedError);
      expect((err as CatalogNotReviewedError).action).toBe("backfill-namespaced-labels --apply");
      expect((err as Error).message).toMatch(/not reviewed/i);
    }
  });
});
