import { JiraClientConfig, basicAuthHeader } from "./sync";
import {
  NS_FEATURE,
  NS_FLOW,
  NS_SYMPTOM,
  NS_BUCKET_FEATURE,
  NS_BUCKET_FLOW,
  NS_PROV_FEATURE,
  LABEL_AUTOCREATED,
  ValidatedLabels,
} from "./namespacedLabels";

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

  /**
   * REMOVE every bot-namespace label (`mb-feature-*` / `mb-flow-*` /
   * `mb-symptom-*`) from `issueKey`, given its CURRENT labels — the reverse of
   * `applyLabels` ("peel off ALL the bot's stickers"). Human/other labels are
   * provably untouched. Returns `true` if a mutating PUT was issued, `false` if
   * the issue carried no bot labels (empty diff → NO PUT → idempotent re-run /
   * already-clean issue makes zero network calls).
   */
  unstampLabels(
    issueKey: string,
    currentLabels: string[],
    prefixes?: readonly string[],
  ): Promise<boolean>;
}

type LabelOp = { add: string } | { remove: string };

/**
 * Every bot-owned namespace the unstamp/peel must cover: the three children, the
 * two parent buckets (#1387), the provisional-child namespace + the flat
 * `mb-autocreated` marker (peeled by exact prefix). Human/other labels never
 * match.
 */
const NS_PREFIXES = [
  NS_FEATURE,
  NS_FLOW,
  NS_SYMPTOM,
  NS_BUCKET_FEATURE,
  NS_BUCKET_FLOW,
  NS_PROV_FEATURE,
  LABEL_AUTOCREATED,
];

/** ONLY the growth namespaces (#1387) — used by `--peel-provisional`. */
export const GROWTH_PREFIXES = [NS_PROV_FEATURE, LABEL_AUTOCREATED];

/**
 * Compute the diff-driven REMOVE op list for an UNSTAMP: a `{ remove }` op for
 * EVERY current label in one of the bot's three namespaces, and NOTHING else
 * (exported for direct unit assertion — mirrors `computeLabelOps`).
 *
 * Bot-namespace-only by construction: a human/other label can never enter the
 * op list. Empty result when the issue carries no bot labels (the idempotency
 * short-circuit consumed by the writer → no PUT).
 */
export function computeUnstampOps(
  currentLabels: string[],
  prefixes: readonly string[] = NS_PREFIXES,
): LabelOp[] {
  const current = currentLabels ?? [];
  const ops: LabelOp[] = [];
  for (const label of current) {
    if (prefixes.some((prefix) => label.startsWith(prefix))) {
      ops.push({ remove: label });
    }
  }
  return ops;
}

/** Compute the diff-driven op list (exported for direct unit assertion). */
export function computeLabelOps(currentLabels: string[], target: ValidatedLabels): LabelOp[] {
  const current = currentLabels ?? [];
  const present = new Set(current);
  const ops: LabelOp[] = [];

  // SINGLE-value namespaces: remove ALL stale, then add target if absent. The
  // feature-bucket (#1387) is single-value like the feature child.
  const single: Array<[string, string | undefined]> = [
    [NS_FEATURE, target.feature],
    [NS_SYMPTOM, target.symptom],
    [NS_BUCKET_FEATURE, target.featureBucket],
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

  // MULTI-value namespaces (additive): desired flows, flow-buckets (#1387), and
  // the TYPED provisional adds (#1387, MED-1: a minted provisional child + its
  // bucket + the `mb-autocreated` marker — without this loop they would be
  // computed in `desired` but NEVER written to Jira).
  const additive = [...target.flows, ...(target.flowBuckets ?? []), ...(target.provisionalAdds ?? [])];
  for (const label of additive) {
    if (!present.has(label)) {
      ops.push({ add: label });
      present.add(label); // guard against an intra-list duplicate double-add.
    }
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

  // SINGLE shared PUT site (no forked auth): both apply + unstamp diff their
  // own op list, then route through this one `{ update: { labels: ops } }` PUT.
  async function putLabelOps(issueKey: string, ops: LabelOp[]): Promise<boolean> {
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
  }

  return {
    async applyLabels(issueKey, currentLabels, target): Promise<boolean> {
      if (typeof issueKey !== "string" || issueKey.length === 0) {
        throw new TypeError("applyLabels: issueKey must be a non-empty string");
      }
      return putLabelOps(issueKey, computeLabelOps(currentLabels, target));
    },

    async unstampLabels(issueKey, currentLabels, prefixes): Promise<boolean> {
      if (typeof issueKey !== "string" || issueKey.length === 0) {
        throw new TypeError("unstampLabels: issueKey must be a non-empty string");
      }
      return putLabelOps(issueKey, computeUnstampOps(currentLabels, prefixes));
    },
  };
}
