/**
 * PURE vocab builder (#1332). Composes the legal `LabelVocab` the NL→JQL seam
 * validates against: the live symptom taxonomy + the catalog's feature/flow
 * entry ids. NO fs / network here — the gitignored-catalog read lives in the CLI
 * shell, which passes a (synthetic or real) `CatalogIdSource` in.
 */
import { DEFECT_CATEGORIES } from "../triage/categorizeDefect";
import { CatalogIdSource, membershipFromCatalog } from "./namespacedLabels";
import { LabelVocab } from "./jqlFromFilter";

/**
 * Build the `LabelVocab` from a catalog + (optionally overridden) symptom set.
 * Reuses `membershipFromCatalog` so the feature/flow id sets are derived exactly
 * as the label writer derives them — one source of truth, no drift.
 */
export function buildVocab(
  catalog: CatalogIdSource,
  symptoms: readonly string[] = DEFECT_CATEGORIES,
): LabelVocab {
  const membership = membershipFromCatalog(catalog);
  return {
    symptoms: new Set(symptoms),
    featureIds: membership.featureIds,
    flowIds: membership.flowIds,
  };
}
