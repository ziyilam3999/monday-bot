/**
 * Catalog "reviewed" safety gate (#1343, nit 3).
 *
 * The catalog is written with `reviewed: false` and the operator flips it to
 * `true` ONLY after hand-checking the distilled feature/flow menu (see
 * `FeatureCatalog.reviewed` in `src/catalog/types.ts`). Any PRODUCTION action
 * that spends real money or writes outward — the real-data eval (`--real`) and
 * the live label backfill (`--apply`) — must REFUSE to run against an unreviewed
 * catalog, FAILING CLOSED with a clear message. A defect-laden auto-distilled
 * menu must never silently drive a cost-incurring eval or a live Jira write.
 *
 * Pure + dependency-free so it is unit-tested with synthetic catalogs.
 */

/** Raised when a production action is attempted against an unreviewed catalog. */
export class CatalogNotReviewedError extends Error {
  constructor(public readonly action: string) {
    super(
      `catalog not reviewed: refusing to run "${action}" — the catalog's ` +
        `reviewed flag is not set. Hand-check the catalog menu and set ` +
        `"reviewed": true before any cost-incurring eval or live label write.`,
    );
    this.name = "CatalogNotReviewedError";
  }
}

/**
 * Throw `CatalogNotReviewedError` unless `catalog.reviewed === true`. Call this
 * BEFORE constructing the real model client (`--real` eval) or the Jira writer
 * (`--apply` backfill). A missing / falsy `reviewed` flag fails closed.
 */
export function assertCatalogReviewed(
  catalog: { reviewed?: boolean } | null | undefined,
  action: string,
): void {
  if (!catalog || catalog.reviewed !== true) {
    throw new CatalogNotReviewedError(action);
  }
}
