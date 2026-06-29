import { scoreEval, estimateCost, type EvalRow } from "../src/triage/featureFlowEval";
import { matchFeatureFlow, type MatcherCatalog } from "../src/triage/featureFlowMatcher";

/**
 * #1343 — eval harness scoring + cost math (AC-6).
 *
 * SYNTHETIC fixtures ONLY; pure arithmetic, ZERO network/model/creds. Each
 * asserted value is HAND-COMPUTED in the comment beside it.
 */

describe("AC-6 — scoreEval scores a fixed synthetic sample deterministically", () => {
  // 4 hand-built rows:
  //   r1: feature ✓ (checkout=checkout); flows exp{payment,signup} pred{payment} → TP 1, pred 1, exp 2
  //   r2: feature ✗ (search≠checkout);   flows exp{} pred{}                       → TP 0, pred 0, exp 0
  //   r3: feature ✓ (none=none);          flows exp{} pred{}                       → none-bucket
  //   r4: feature ✓ (checkout=checkout); flows exp{payment} pred{payment,extra}   → TP 1, pred 2, exp 1
  const ROWS: EvalRow[] = [
    {
      expectedFeature: "feature-checkout",
      expectedFlows: ["flow-payment", "flow-signup"],
      predictedFeature: "feature-checkout",
      predictedFlows: ["flow-payment"],
    },
    {
      expectedFeature: "feature-search",
      expectedFlows: [],
      predictedFeature: "feature-checkout",
      predictedFlows: [],
    },
    {
      expectedFeature: undefined,
      expectedFlows: [],
      predictedFeature: undefined,
      predictedFlows: [],
    },
    {
      expectedFeature: "feature-checkout",
      expectedFlows: ["flow-payment"],
      predictedFeature: "feature-checkout",
      predictedFlows: ["flow-payment", "flow-extra"],
    },
  ];

  it("computes feature accuracy, flow precision/recall, confident/none counts", () => {
    const score = scoreEval(ROWS);
    expect(score.total).toBe(4);
    expect(score.featureCorrect).toBe(3); // r1, r3, r4
    expect(score.featureAccuracy).toBeCloseTo(0.75, 10); // 3/4
    // flow TP total = 2 (r1:1 + r4:1); predicted total = 3 (r1:1 + r4:2); expected total = 3 (r1:2 + r4:1)
    expect(score.flowPrecision).toBeCloseTo(2 / 3, 10);
    expect(score.flowRecall).toBeCloseTo(2 / 3, 10);
    expect(score.confident).toBe(3); // r1, r2, r4 predicted a feature
    expect(score.none).toBe(1); // r3 routed to the none fallback
  });

  it("scores a sample produced by the matcher with a fake complete (end-to-end synthetic)", async () => {
    const CATALOG: MatcherCatalog = {
      features: [{ id: "feature-checkout", label: "Checkout" }],
      flows: [{ id: "flow-payment", label: "Payment" }],
    };
    const cases = [
      {
        canned: '{"feature":"feature-checkout","flows":["flow-payment"],"confidence":"high"}',
        expectedFeature: "feature-checkout",
        expectedFlows: ["flow-payment"],
      },
      {
        canned: '{"feature":null,"flows":[],"confidence":"low"}',
        expectedFeature: undefined,
        expectedFlows: [],
      },
    ];
    const rows: EvalRow[] = [];
    for (const c of cases) {
      const predicted = await matchFeatureFlow(CATALOG, async () => c.canned, {
        summary: "x",
        descriptionText: "",
      });
      rows.push({
        expectedFeature: c.expectedFeature,
        expectedFlows: c.expectedFlows,
        predictedFeature: predicted.feature,
        predictedFlows: predicted.flows,
      });
    }
    const score = scoreEval(rows);
    expect(score.featureAccuracy).toBe(1); // both correct (one confident, one clean none)
    expect(score.confident).toBe(1);
    expect(score.none).toBe(1);
  });

  it("empty sample yields zero accuracy and unit precision/recall", () => {
    const score = scoreEval([]);
    expect(score.total).toBe(0);
    expect(score.featureAccuracy).toBe(0);
    expect(score.flowPrecision).toBe(1);
    expect(score.flowRecall).toBe(1);
  });
});

describe("AC-6 — estimateCost projects total tokens + USD (no-cache upper bound)", () => {
  it("matches the hand-computed ~$0.60 for the ~259-defect corpus", () => {
    // 2,050 in + 50 out per defect; Haiku 4.5 $1.00/$5.00 per MTok; 259 defects.
    const cost = estimateCost(2050, 50, 259, { inputPerMTok: 1.0, outputPerMTok: 5.0 });
    expect(cost.totalInputTokens).toBe(530950); // 2050 * 259
    expect(cost.totalOutputTokens).toBe(12950); // 50 * 259
    // 530950/1e6 * 1.0 + 12950/1e6 * 5.0 = 0.53095 + 0.06475 = 0.5957
    expect(cost.estimatedUsd).toBeCloseTo(0.5957, 4);
  });

  it("scales linearly with defect count", () => {
    const one = estimateCost(2050, 50, 1, { inputPerMTok: 1.0, outputPerMTok: 5.0 });
    expect(one.estimatedUsd).toBeCloseTo(0.0023, 4); // ~$0.0023 per defect
  });
});
