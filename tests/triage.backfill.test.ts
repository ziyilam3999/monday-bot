import { run } from "../src/triage/backfill";
import { buildJiraNamespacedLabelWriter } from "../src/jira/namespacedLabelWriter";
import { membershipFromCatalog } from "../src/jira/namespacedLabels";
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
