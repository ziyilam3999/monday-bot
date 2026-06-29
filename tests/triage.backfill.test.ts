import { run } from "../src/triage/backfill";
import { buildJiraNamespacedLabelWriter } from "../src/jira/namespacedLabelWriter";
import { buildDesiredLabels, membershipFromCatalog } from "../src/jira/namespacedLabels";
import type { IssueFeatureFlowClassifier } from "../src/triage/classifier";
import type { JiraIssue } from "../src/jira/sync";

/**
 * #1322 — backfill core (enumerate open defects → validate → write).
 *
 * SYNTHETIC fixtures ONLY: invented slugs, no live network. The writer's
 * `fetchImpl` is a `jest.fn()` SPY so AC-7 can assert ZERO PUT calls on an
 * already-correct re-run (empty-diff short-circuit).
 */

const CONFIG = { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" };

/** Synthetic catalog: one feature + one flow. */
const MEMBERSHIP = membershipFromCatalog({
  features: [{ id: "feature-checkout" }],
  flows: [{ id: "flow-signin" }],
});

/** Deterministic fake classifier keyed by issue. */
const CLASSIFIER: IssueFeatureFlowClassifier = {
  async classify(issue: JiraIssue) {
    if (issue.key === "X-1") return { feature: "checkout", flows: ["signin"] };
    return { feature: "checkout", flows: [] };
  },
};

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

describe("AC-7 — backfill enumerates open issues AND is idempotent (spied fetchImpl)", () => {
  it("run#1 writes each issue; run#2 over already-correct issues issues ZERO PUTs", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);

    // Run #1: clean issues (no mb-* labels yet).
    const run1Issues: JiraIssue[] = [
      { key: "X-1", summary: "the app crashed on launch", descriptionText: "", commentTexts: [] },
      {
        key: "X-2",
        summary: "the running total shows the wrong amount",
        descriptionText: "",
        commentTexts: [],
      },
    ];
    const result1 = await run({
      fetchOpenDefects: async () => run1Issues,
      classifier: CLASSIFIER,
      catalog: MEMBERSHIP,
      writer,
      apply: true,
      log: () => undefined,
    });
    expect(result1.total).toBe(2);
    expect(result1.validated).toBe(2);
    expect(result1.rejected).toBe(0);
    expect(result1.applied).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Run #2: the SAME issues now carrying their correct mb-* labels.
    fetchImpl.mockClear();
    const run2Issues: JiraIssue[] = [
      {
        key: "X-1",
        summary: "the app crashed on launch",
        descriptionText: "",
        commentTexts: [],
        labels: ["mb-feature-checkout", "mb-flow-signin", "mb-symptom-crash-error"],
      },
      {
        key: "X-2",
        summary: "the running total shows the wrong amount",
        descriptionText: "",
        commentTexts: [],
        labels: ["mb-feature-checkout", "mb-symptom-data-incorrect"],
      },
    ];
    const result2 = await run({
      fetchOpenDefects: async () => run2Issues,
      classifier: CLASSIFIER,
      catalog: MEMBERSHIP,
      writer,
      apply: true,
      log: () => undefined,
    });
    expect(result2.applied).toBe(0);
    // The empty-diff short-circuit fired: NO PUT was issued on the re-run.
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("dry-run default makes ZERO writes", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);
    const result = await run({
      fetchOpenDefects: async () => [
        { key: "X-1", summary: "the app crashed", descriptionText: "", commentTexts: [] },
      ],
      classifier: CLASSIFIER,
      catalog: MEMBERSHIP,
      writer,
      apply: false,
      log: () => undefined,
    });
    expect(result.applied).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });
});

describe("AC-5 (backfill) — unknown value → rejected + ZERO fetch", () => {
  it("rejects an unknown feature and never calls the writer's fetchImpl", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);
    const badClassifier: IssueFeatureFlowClassifier = {
      async classify() {
        return { feature: "not-in-catalog", flows: [] };
      },
    };
    const result = await run({
      fetchOpenDefects: async () => [
        { key: "X-9", summary: "the app crashed", descriptionText: "", commentTexts: [] },
      ],
      classifier: badClassifier,
      catalog: MEMBERSHIP,
      writer,
      apply: true,
      log: () => undefined,
    });
    expect(result.rejected).toBe(1);
    expect(result.validated).toBe(0);
    expect(result.applied).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });
});

describe("#1381 — classifier returns CANONICAL ids (matcher shape) → validated, not rejected", () => {
  it("a classifier returning feature-<slug> / flow-<slug> ids validates with ZERO rejects", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);
    // The real matcher returns canonical catalog ids, not bare names. Before the
    // #1381 fix this re-prefixed to feature-feature-* and rejected EVERY issue.
    const canonicalClassifier: IssueFeatureFlowClassifier = {
      async classify() {
        return { feature: "feature-checkout", flows: ["flow-signin"] };
      },
    };
    const result = await run({
      fetchOpenDefects: async () => [
        { key: "X-1", summary: "the app crashed on launch", descriptionText: "", commentTexts: [] },
        { key: "X-2", summary: "the app crashed on launch", descriptionText: "", commentTexts: [] },
      ],
      classifier: canonicalClassifier,
      catalog: MEMBERSHIP,
      writer,
      apply: true,
      log: () => undefined,
    });
    expect(result.validated).toBeGreaterThan(0);
    expect(result.rejected).toBe(0);
  });
});

describe("AC-7 (#1343) — feature/flow pass is ADDITIVE: mb-symptom-* untouched", () => {
  it("adds mb-feature-* and leaves the pre-existing mb-symptom-* label in place", async () => {
    // Capture the PUT body so we can prove the symptom label is never removed.
    const calls: Array<{ url: string; ops: unknown[] }> = [];
    const fetchImpl = jest.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      calls.push({ url, ops: body.update.labels });
      return { ok: true, status: 204, statusText: "No Content", async json() {return {};} };
    });
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);

    // Issue already carries its symptom label (from the shipped symptom backfill);
    // the classifier now assigns a feature on top.
    const issues: JiraIssue[] = [
      {
        key: "X-7",
        summary: "the app crashed on launch",
        descriptionText: "",
        commentTexts: [],
        labels: ["mb-symptom-crash-error"],
      },
    ];
    const result = await run({
      fetchOpenDefects: async () => issues,
      classifier: CLASSIFIER, // assigns feature "checkout"
      catalog: MEMBERSHIP,
      writer,
      apply: true,
      log: () => undefined,
    });
    expect(result.applied).toBe(1);

    // Exactly one PUT; its op list ADDS the feature and removes NOTHING.
    expect(calls).toHaveLength(1);
    const ops = calls[0].ops as Array<{ add?: string; remove?: string }>;
    expect(ops).toContainEqual({ add: "mb-feature-checkout" });
    // No op removes the symptom label (additive guarantee).
    expect(ops.some((o) => o.remove === "mb-symptom-crash-error")).toBe(false);
    expect(ops.some((o) => "remove" in o)).toBe(false);
  });

  it("desired set always includes the symptom alongside an assigned feature", () => {
    const desired = buildDesiredLabels(
      { feature: "checkout", flows: ["signin"], symptom: "crash-error" },
      MEMBERSHIP,
      undefined,
      () => undefined,
    );
    expect(desired.desired).toContain("mb-feature-checkout");
    expect(desired.desired).toContain("mb-symptom-crash-error");
    expect(desired.symptom).toBe("mb-symptom-crash-error");
  });
});
