import { categorizeDefect } from "./categorizeDefect";
import { IssueFeatureFlowClassifier } from "./classifier";
import type { JiraIssue } from "../jira/sync";
import type { JiraNamespacedLabelWriter } from "../jira/namespacedLabelWriter";
import {
  LabelAssignment,
  LabelCatalog,
  LabelValidationError,
  buildDesiredLabels,
} from "../jira/namespacedLabels";

/**
 * Injectable backfill core (#1322) — mirrors `src/triage/cli.ts`.
 *
 * Per open issue: symptom from the deterministic `categorizeDefect` + feature/
 * flows from the INJECTED classifier seam → VALIDATE against the catalog/
 * taxonomy → write. Validation precedes the writer: an unknown value is counted
 * as `rejected` and the writer is NEVER called for that issue (zero network).
 *
 * Dry-run is the DEFAULT: with `apply !== true` (or no writer) it computes +
 * previews and issues ZERO writes. `applied` counts only issues that actually
 * received a mutating PUT — an already-correct issue produces an empty diff →
 * NO PUT → does NOT increment `applied` (the idempotency guarantee). Env-cred
 * construction lives in the thin shell, never here.
 */
export interface BackfillRunDeps {
  /** Injected open-defects read. */
  fetchOpenDefects: () => Promise<JiraIssue[]>;
  /** Injected feature/flow classifier seam (fake in tests). */
  classifier: IssueFeatureFlowClassifier;
  /** Injected catalog membership sets (synthetic in tests). */
  catalog: LabelCatalog;
  /** Injected writer — constructed by the shell ONLY on `--apply`. */
  writer?: JiraNamespacedLabelWriter;
  /** Real-write flag. Default false (dry-run). */
  apply?: boolean;
  /** Logger sink; defaults to `console.log`. */
  log?: (msg: string) => void;
}

export interface BackfillRunResult {
  /** Issues processed. */
  total: number;
  /** Issues whose assignment passed validation. */
  validated: number;
  /** Issues rejected by validation (unknown feature/flow/symptom). */
  rejected: number;
  /** Issues that actually received a mutating PUT (0 in dry-run / on re-run). */
  applied: number;
}

export async function run(deps: BackfillRunDeps): Promise<BackfillRunResult> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const apply = deps.apply === true;

  const issues = await deps.fetchOpenDefects();
  let validated = 0;
  let rejected = 0;
  let applied = 0;

  for (const issue of issues) {
    const { category } = categorizeDefect({
      key: issue.key,
      summary: issue.summary,
      descriptionText: issue.descriptionText,
      labels: issue.labels,
      issueType: issue.issueType,
    });
    const ff = await deps.classifier.classify(issue);
    const assignment: LabelAssignment = {
      feature: ff.feature,
      flows: ff.flows ?? [],
      symptom: category,
    };

    let target;
    try {
      target = buildDesiredLabels(assignment, deps.catalog, undefined, log);
    } catch (err) {
      if (err instanceof LabelValidationError) {
        // Fail-loud already logged inside the model; never reach the writer.
        rejected++;
        continue;
      }
      throw err;
    }
    validated++;

    if (apply && deps.writer && issue.key) {
      const didPut = await deps.writer.applyLabels(issue.key, issue.labels ?? [], target);
      if (didPut) applied++;
    }
  }

  log(
    `backfill: total=${issues.length} validated=${validated} rejected=${rejected} ` +
      `applied=${applied} (${apply ? "APPLY" : "dry-run"})`,
  );

  return { total: issues.length, validated, rejected, applied };
}
