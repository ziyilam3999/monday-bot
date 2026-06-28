import type { JiraIssue } from "../jira/sync";

/**
 * Single injected boundary that decides WHICH feature / flows a given issue maps
 * to (#1322). Modeled on the catalog's `CatalogDistiller` seam: the production
 * implementation (an LLM matching issue text → catalog ids) lives in the thin
 * SHELL, never here; tests inject a fake so the whole backfill runs with ZERO
 * network / model / creds.
 *
 * The PRODUCTION feature/flow classifier (prompt + accuracy tuning) is a
 * DEFERRED follow-up under EPIC #1064 — until it lands, the backfill wires
 * `buildNullClassifier` and runs SYMPTOM-ONLY (the deterministic axis), which is
 * exactly the documented interim mode.
 */
export interface IssueFeatureFlowClassifier {
  classify(issue: JiraIssue): Promise<{ feature?: string; flows: string[] }>;
}

/**
 * Symptom-only fallback: assigns no feature and no flows, so the backfill stamps
 * only the deterministic `mb-symptom-*` axis. This is the wired default until the
 * real LLM classifier ships (see the deferred follow-up above).
 */
export function buildNullClassifier(): IssueFeatureFlowClassifier {
  return {
    async classify(): Promise<{ feature?: string; flows: string[] }> {
      return { flows: [] };
    },
  };
}
