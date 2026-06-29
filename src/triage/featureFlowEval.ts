/**
 * Pure scoring + cost-estimate math for the feature/flow eval harness (#1343).
 *
 * Factored out of the `scripts/feature-flow-eval.js` shell so the accuracy +
 * cost arithmetic is unit-tested deterministically against synthetic fixtures
 * (zero network / model / creds). The shell (a) runs the matcher to produce the
 * `predicted` half of each row, then (b) feeds the rows here for scoring, and
 * (c) prints COUNTS/STRUCTURE only — never defect text, labels, or catalog
 * vocabulary.
 */

/** One scored row: the labeled expectation vs the matcher's prediction. */
export interface EvalRow {
  expectedFeature?: string;
  expectedFlows: string[];
  predictedFeature?: string;
  predictedFlows: string[];
}

/** Aggregate accuracy report — counts + rates only (no vocabulary). */
export interface EvalScore {
  /** Rows scored. */
  total: number;
  /** Rows whose predicted feature exactly matched the expected feature
   * (including both-absent — a correct "none"). */
  featureCorrect: number;
  /** featureCorrect / total (0 when total === 0). */
  featureAccuracy: number;
  /** Flow-id precision over all predicted flows (1 when none predicted). */
  flowPrecision: number;
  /** Flow-id recall over all expected flows (1 when none expected). */
  flowRecall: number;
  /** Rows where the matcher assigned a feature (confident). */
  confident: number;
  /** Rows routed to the unknown/none fallback (no feature assigned). */
  none: number;
}

/** Score a set of eval rows. Pure + deterministic. */
export function scoreEval(rows: ReadonlyArray<EvalRow>): EvalScore {
  let featureCorrect = 0;
  let confident = 0;
  let none = 0;
  let flowTruePositives = 0;
  let predictedFlowTotal = 0;
  let expectedFlowTotal = 0;

  for (const row of rows) {
    const expF = row.expectedFeature ?? undefined;
    const predF = row.predictedFeature ?? undefined;
    if (expF === predF) featureCorrect++;
    if (predF !== undefined) confident++;
    else none++;

    const expectedFlows = new Set(row.expectedFlows ?? []);
    const predictedFlows = row.predictedFlows ?? [];
    predictedFlowTotal += predictedFlows.length;
    expectedFlowTotal += expectedFlows.size;
    for (const f of predictedFlows) {
      if (expectedFlows.has(f)) flowTruePositives++;
    }
  }

  const total = rows.length;
  return {
    total,
    featureCorrect,
    featureAccuracy: total === 0 ? 0 : featureCorrect / total,
    flowPrecision: predictedFlowTotal === 0 ? 1 : flowTruePositives / predictedFlowTotal,
    flowRecall: expectedFlowTotal === 0 ? 1 : flowTruePositives / expectedFlowTotal,
    confident,
    none,
  };
}

/** Per-MTok pricing for the eval cost projection. */
export interface TokenPricing {
  /** USD per 1,000,000 input tokens. */
  inputPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMTok: number;
}

/** Total token + cost projection for a full-corpus real dry-run. */
export interface CostEstimate {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedUsd: number;
}

/**
 * Project total tokens + USD for running the matcher over `defectCount` defects
 * at a fixed per-defect token budget. No-cache upper bound (the headline number
 * the operator approves at Gate A). Pure arithmetic.
 */
export function estimateCost(
  perDefectInputTokens: number,
  perDefectOutputTokens: number,
  defectCount: number,
  pricing: TokenPricing,
): CostEstimate {
  const totalInputTokens = perDefectInputTokens * defectCount;
  const totalOutputTokens = perDefectOutputTokens * defectCount;
  const estimatedUsd =
    (totalInputTokens / 1_000_000) * pricing.inputPerMTok +
    (totalOutputTokens / 1_000_000) * pricing.outputPerMTok;
  return { totalInputTokens, totalOutputTokens, estimatedUsd };
}
