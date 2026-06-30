import { buildVocab } from "../src/jira/labelVocab";
import { CatalogIdSource } from "../src/jira/namespacedLabels";
import { DEFECT_CATEGORIES } from "../src/triage/categorizeDefect";

/**
 * #1385 — `buildVocab` derives the lean BUCKET id sets from the optional
 * full→lean `parentOf` map. SYNTHETIC ids only.
 */

const CATALOG: CatalogIdSource = {
  features: [{ id: "feature-widget" }, { id: "feature-onboarding" }],
  flows: [{ id: "flow-onboarding" }, { id: "flow-checkout" }],
};

describe("buildVocab (#1385 lean-bucket derivation)", () => {
  it("splits the DISTINCT lean bucket ids by axis prefix into feature/flow bucket sets", () => {
    const parentOf = new Map<string, string>([
      ["feature-widget", "feature-platform"],
      ["feature-onboarding", "feature-platform"], // duplicate lean id → deduped
      ["flow-onboarding", "flow-platform"],
      ["flow-checkout", "flow-core"],
    ]);
    const vocab = buildVocab(CATALOG, undefined, parentOf);

    expect([...(vocab.featureBucketIds ?? [])].sort()).toEqual(["feature-platform"]);
    expect([...(vocab.flowBucketIds ?? [])].sort()).toEqual(["flow-core", "flow-platform"]);
    // Child id sets are unchanged.
    expect(vocab.featureIds.has("feature-widget")).toBe(true);
    expect(vocab.flowIds.has("flow-checkout")).toBe(true);
    // Symptom default still applied.
    expect([...vocab.symptoms].sort()).toEqual([...DEFECT_CATEGORIES].sort());
  });

  it("absent parentOf ⇒ EMPTY bucket sets (behaviour identical to pre-#1385)", () => {
    const vocab = buildVocab(CATALOG);
    expect([...(vocab.featureBucketIds ?? [])]).toEqual([]);
    expect([...(vocab.flowBucketIds ?? [])]).toEqual([]);
  });
});
