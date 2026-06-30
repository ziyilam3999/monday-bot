import {
  computeLabelOps,
  computeUnstampOps,
  buildJiraNamespacedLabelWriter,
} from "../src/jira/namespacedLabelWriter";
import {
  buildDesiredLabels,
  withProvisionalChild,
  type LabelCatalog,
  type ValidatedLabels,
} from "../src/jira/namespacedLabels";

/**
 * #1387 — writer ops for the DUAL parent buckets + the TYPED provisional adds.
 *
 * SYNTHETIC fixtures ONLY; the write path is driven by a spied fake `fetchImpl`
 * with ZERO live mutation.
 */
const CONFIG = { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" };

function okFetchSpy(): jest.Mock {
  return jest.fn(async () => ({
    ok: true,
    status: 204,
    statusText: "No Content",
    async json() {
      return {};
    },
  }));
}

const DUAL_CATALOG: LabelCatalog = {
  featureIds: new Set(["feature-widget"]),
  flowIds: new Set(["flow-onboarding"]),
  parentOf: new Map([
    ["feature-widget", "feature-tools"],
    ["flow-onboarding", "flow-account"],
  ]),
};

describe("#1387 #9 — feature-bucket is single-value (remove stale, add new)", () => {
  it("removes a stale mb-bucket-feature-* and adds the target bucket", () => {
    const target = buildDesiredLabels(
      { feature: "feature-widget", flows: [], symptom: "crash-error" },
      DUAL_CATALOG,
      undefined,
      () => {},
    );
    const ops = computeLabelOps(["mb-bucket-feature-old", "keep-me"], target);
    expect(ops).toContainEqual({ remove: "mb-bucket-feature-old" });
    expect(ops).toContainEqual({ add: "mb-bucket-feature-tools" });
    expect(JSON.stringify(ops)).not.toContain("keep-me");
  });
});

describe("#1387 #10 — flow-buckets are additive (add desired, remove none)", () => {
  it("adds the desired flow bucket and removes no flow bucket", () => {
    const target = buildDesiredLabels(
      { flows: ["flow-onboarding"], symptom: "crash-error" },
      DUAL_CATALOG,
      undefined,
      () => {},
    );
    const ops = computeLabelOps(["mb-bucket-flow-existing"], target);
    expect(ops).toContainEqual({ add: "mb-bucket-flow-account" });
    // Additive: a different existing flow bucket is NOT removed.
    expect(ops.some((o) => "remove" in o)).toBe(false);
  });
});

describe("#1387 #11 — unstamp peels parents + provisional + marker, human untouched", () => {
  it("removes every bot label across all namespaces, leaves a human label", () => {
    const ops = computeUnstampOps([
      "mb-feature-x",
      "mb-bucket-feature-x",
      "mb-bucket-flow-y",
      "mb-prov-feature-z",
      "mb-autocreated",
      "keep-me",
    ]);
    const removed = new Set(ops.map((o) => ("remove" in o ? o.remove : "")));
    expect(removed).toEqual(
      new Set([
        "mb-feature-x",
        "mb-bucket-feature-x",
        "mb-bucket-flow-y",
        "mb-prov-feature-z",
        "mb-autocreated",
      ]),
    );
    expect(JSON.stringify(ops)).not.toContain("keep-me");
  });
});

describe("#1387 #12 GOLDEN — provisional adds land in the WRITE BODY (MED-2)", () => {
  it("a minted provisional child + bucket + marker appear as real add ops in the PUT", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);

    // Symptom-only base (the abstain shape), then a minted provisional child.
    const base: ValidatedLabels = buildDesiredLabels(
      { flows: [], symptom: "crash-error" },
      DUAL_CATALOG,
      undefined,
      () => {},
    );
    const target = withProvisionalChild(base, "dark-mode", "feature-tools");

    const didPut = await writer.applyLabels("DEMO-1", [], target);
    expect(didPut).toBe(true);

    const init = fetchImpl.mock.calls[0][1] as { body: string };
    const ops = JSON.parse(init.body).update.labels as Array<{ add?: string; remove?: string }>;
    // The mint is WRITTEN, not merely computed in `desired` (a `desired`-only
    // implementation would FAIL these three assertions).
    expect(ops).toContainEqual({ add: "mb-prov-feature-dark-mode" });
    expect(ops).toContainEqual({ add: "mb-bucket-feature-tools" });
    expect(ops).toContainEqual({ add: "mb-autocreated" });
  });
});
