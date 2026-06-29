/**
 * Pure classifier-selection seam for the backfill shell (#1355).
 *
 * Decides WHICH `IssueFeatureFlowClassifier` the backfill injects, given the
 * operator's flags + the loaded catalog. Extracted from the thin shell so the
 * cost / gating precedence is unit-tested with ZERO network / model / creds.
 *
 * Precedence (cost-safe):
 *   1. symptomOnly        → buildNullClassifier()  (free, deterministic; wins even
 *                           under --real / --apply — the documented escape hatch)
 *   2. real || apply      → assertCatalogReviewed(...) BEFORE building the paid
 *                           production classifier — FAIL CLOSED before any spend
 *   3. default (no flags) → buildNullClassifier()  (free symptom-only preview)
 *
 * The paid `complete` boundary is injected as a FACTORY (`completeFactory`) and
 * is invoked ONLY on the gated paid path — so the default / symptom-only paths
 * never touch the Anthropic client, and an unreviewed catalog throws BEFORE the
 * factory (and therefore `getClient`) is ever called.
 */
import { buildNullClassifier, type IssueFeatureFlowClassifier } from "./classifier";
import { buildFeatureFlowClassifier, type CompleteFn } from "./featureFlowMatcher";
import { assertCatalogReviewed } from "../catalog/reviewedGate";

export interface SelectBackfillClassifierOptions {
  /** `--apply` — live outward write; implies the paid production classifier. */
  apply: boolean;
  /** `--real` — paid production classifier, dry-run PREVIEW (classifies, no write). */
  real: boolean;
  /** `--symptom-only` — force the free null classifier even under --real/--apply. */
  symptomOnly: boolean;
  /** Loaded catalog; its `reviewed` flag gates every paid path. */
  catalog: {
    reviewed?: boolean;
    features: ReadonlyArray<{ id: string; label: string }>;
    flows: ReadonlyArray<{ id: string; label: string }>;
  };
  /** Builds the paid `complete` boundary; invoked ONLY on the gated paid path. */
  completeFactory: () => CompleteFn;
  /** Action label for the fail-closed error message. */
  action?: string;
}

/**
 * Select the backfill's `IssueFeatureFlowClassifier`. The paid production
 * classifier is built ONLY on an explicit `--real` / `--apply` opt-in, and the
 * catalog-reviewed gate fires BEFORE it is constructed — so the default no-flag
 * run is a FREE symptom-only preview and an unreviewed catalog never spends.
 */
export function selectBackfillClassifier(
  opts: SelectBackfillClassifierOptions,
): IssueFeatureFlowClassifier {
  const { apply, real, symptomOnly, catalog, completeFactory, action } = opts;

  // 1. Explicit override → free null classifier, no spend, even under --real/--apply.
  if (symptomOnly) {
    return buildNullClassifier();
  }

  // 2. Paid path (real preview OR live apply): FAIL CLOSED before constructing the
  //    production classifier — an unreviewed, auto-distilled menu must never spend.
  if (real || apply) {
    assertCatalogReviewed(
      catalog,
      action ?? "backfill-namespaced-labels (real classifier)",
    );
    return buildFeatureFlowClassifier(
      { features: catalog.features, flows: catalog.flows },
      completeFactory(),
    );
  }

  // 3. Default no-flag run → free null classifier (symptom-only preview, ZERO cost).
  return buildNullClassifier();
}
