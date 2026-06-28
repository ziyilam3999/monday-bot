import {
  categorizeAll,
  CategoryExtensions,
  DEFECT_CATEGORIES,
  DefectCategory,
  DefectInput,
  DefectResult,
} from "./categorizeDefect";
import type { JiraIssue } from "../jira/sync";
import type { JiraCategoryWriter } from "../jira/categoryWriter";

/**
 * Injectable core of the categorize-defects CLI. Accepts an injected open-defects
 * fetcher + (optional) writer so a test can drive the FULL path — including the
 * `--apply`-positive write path — against a FAKE, never touching real creds. The
 * env-cred construction lives in the thin outer shell (`scripts/categorize-defects.js`),
 * NEVER in here.
 *
 * Dry-run is the DEFAULT: when `apply` is false (or no writer is supplied), the
 * core computes + previews categories and issues ZERO writes. The writer is
 * exercised ONLY when `apply === true` AND a writer is injected (AC-7).
 */
export interface CategorizeRunDeps {
  /** Injected open-defects read — returns the issues to categorize. */
  fetchOpenDefects: () => Promise<JiraIssue[]>;
  /** Injected writer — constructed by the shell ONLY on `--apply`. */
  writer?: JiraCategoryWriter;
  /** Real-write flag. Default false (dry-run). */
  apply?: boolean;
  /** Logger sink; defaults to `console.log`. */
  log?: (msg: string) => void;
  /**
   * Optional runtime keyword extensions (compiled by the shell's loader from a
   * gitignored local file). When absent, classification is identical to today.
   */
  extensions?: CategoryExtensions;
}

export interface CategorizeRunResult {
  results: DefectResult[];
  counts: Record<DefectCategory, number>;
  /** Number of category writes performed (always 0 in dry-run). */
  applied: number;
}

function toDefectInput(issue: JiraIssue): DefectInput {
  return {
    key: issue.key,
    summary: issue.summary,
    descriptionText: issue.descriptionText,
    labels: issue.labels,
    issueType: issue.issueType,
  };
}

export async function run(deps: CategorizeRunDeps): Promise<CategorizeRunResult> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const apply = deps.apply === true;

  const issues = await deps.fetchOpenDefects();
  const inputs = issues.map(toDefectInput);
  const { results, counts } = categorizeAll(inputs, deps.extensions);

  // Per-defect planned category (preview).
  log(`Categorized ${results.length} open defect(s) (${apply ? "APPLY" : "dry-run"}):`);
  for (const r of results) {
    log(`  ${r.key ?? "(no key)"} -> ${r.category} [${r.matchedRule}]`);
  }
  // Grouped-counts tally.
  log("Category tally:");
  for (const category of DEFECT_CATEGORIES) {
    log(`  ${category}: ${counts[category]}`);
  }

  let applied = 0;
  if (apply && deps.writer) {
    for (const r of results) {
      if (!r.key) continue;
      await deps.writer.setCategory(r.key, r.category);
      applied++;
    }
  }

  return { results, counts, applied };
}
