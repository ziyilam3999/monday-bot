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
 *
 * The optional `parentOf` map (#1385, full child id → lean BUCKET id) is threaded
 * through, and the DISTINCT lean bucket ids it points to are split by axis prefix
 * (`feature-`/`flow-`) into `featureBucketIds`/`flowBucketIds` so the builder can
 * accept a family/bucket name as input. Absent map → empty bucket sets (behaviour
 * identical to pre-#1385).
 */
export function buildVocab(
  catalog: CatalogIdSource,
  symptoms: readonly string[] = DEFECT_CATEGORIES,
  parentOf?: ReadonlyMap<string, string>,
): LabelVocab {
  const membership = membershipFromCatalog(catalog, parentOf);
  const featureBucketIds = new Set<string>();
  const flowBucketIds = new Set<string>();
  if (parentOf) {
    for (const leanId of parentOf.values()) {
      if (leanId.startsWith("feature-")) featureBucketIds.add(leanId);
      else if (leanId.startsWith("flow-")) flowBucketIds.add(leanId);
    }
  }
  return {
    symptoms: new Set(symptoms),
    featureIds: membership.featureIds,
    flowIds: membership.flowIds,
    featureBucketIds,
    flowBucketIds,
  };
}
