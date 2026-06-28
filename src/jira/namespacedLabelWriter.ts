import { JiraClientConfig, basicAuthHeader } from "./sync";
import { NS_FEATURE, NS_SYMPTOM, ValidatedLabels } from "./namespacedLabels";

/**
 * OUTWARD-write seam for the bot's namespaced labels (#1322).
 *
 * Reuses the SINGLE shared `basicAuthHeader` + the same
 * `PUT /rest/api/3/issue/{key}` endpoint as the category writer (no forked auth
 * site). `fetchImpl` is injectable so the whole path is driven by a fake in
 * tests with ZERO live mutation.
 *
 * The write is a DIFF-driven remove+add op list (NOT a `{set:[...]}` replace),
 * computed uniformly across all three namespaces vs the issue's CURRENT labels:
 *
 *   - SINGLE-value namespaces (`mb-feature-*`, `mb-symptom-*`): emit a `remove`
 *     op for EVERY existing label in that namespace whose value differs from the
 *     target (so two-or-more stale labels are ALL dropped), then an `add` for
 *     the target ONLY if it is not already present.
 *   - MULTI-value namespace (`mb-flow-*`): emit an `add` ONLY for each desired
 *     flow NOT already on the issue (additive within the desired set).
 *
 * remove+add touches ONLY the bot's namespace, so human labels are provably
 * untouched and a human label added between read and write survives. If the
 * computed op list is EMPTY → NO PUT is issued (the idempotency short-circuit):
 * a re-run over an already-correct issue makes zero network calls.
 */
export interface JiraNamespacedLabelWriter {
  /**
   * Apply the validated bot labels to `issueKey` given its CURRENT labels.
   * Returns `true` if a mutating PUT was issued, `false` if the diff was empty
   * (no-op / idempotent re-run → no PUT).
   */
  applyLabels(
    issueKey: string,
    currentLabels: string[],
    target: ValidatedLabels,
  ): Promise<boolean>;
}

type LabelOp = { add: string } | { remove: string };

/** Compute the diff-driven op list (exported for direct unit assertion). */
export function computeLabelOps(currentLabels: string[], target: ValidatedLabels): LabelOp[] {
  const current = currentLabels ?? [];
  const present = new Set(current);
  const ops: LabelOp[] = [];

  // SINGLE-value namespaces: remove ALL stale, then add target if absent.
  const single: Array<[string, string | undefined]> = [
    [NS_FEATURE, target.feature],
    [NS_SYMPTOM, target.symptom],
  ];
  for (const [prefix, targetLabel] of single) {
    if (!targetLabel) continue;
    for (const label of current) {
      if (label.startsWith(prefix) && label !== targetLabel) {
        ops.push({ remove: label });
      }
    }
    if (!present.has(targetLabel)) ops.push({ add: targetLabel });
  }

  // MULTI-value namespace: add only desired flows not already present.
  for (const flow of target.flows) {
    if (!present.has(flow)) ops.push({ add: flow });
  }

  return ops;
}

export function buildJiraNamespacedLabelWriter(
  config: JiraClientConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): JiraNamespacedLabelWriter {
  if (typeof fetchImpl !== "function") {
    throw new TypeError(
      "buildJiraNamespacedLabelWriter: no global fetch available; pass an explicit fetchImpl",
    );
  }
  const base = config.baseUrl.replace(/\/$/, "");

  return {
    async applyLabels(issueKey, currentLabels, target): Promise<boolean> {
      if (typeof issueKey !== "string" || issueKey.length === 0) {
        throw new TypeError("applyLabels: issueKey must be a non-empty string");
      }
      const ops = computeLabelOps(currentLabels, target);
      // Empty-diff short-circuit: issue NO PUT at all (idempotency guarantee).
      if (ops.length === 0) return false;

      const url = `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
      const res = await fetchImpl(url, {
        method: "PUT",
        headers: {
          Authorization: basicAuthHeader(config),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ update: { labels: ops } }),
      });
      if (!res.ok) {
        throw new Error(
          `Jira REST API returned ${res.status} ${res.statusText} for PUT issue ${issueKey}`,
        );
      }
      return true;
    },
  };
}
