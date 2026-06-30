import { categorizeDefect, CategoryExtensions } from "./categorizeDefect";
import { IssueFeatureFlowClassifier } from "./classifier";
import type { JiraIssue } from "../jira/sync";
import {
  computeUnstampOps,
  type JiraNamespacedLabelWriter,
} from "../jira/namespacedLabelWriter";
import {
  LabelAssignment,
  LabelCatalog,
  LabelValidationError,
  buildDesiredLabels,
  withProvisionalChild,
} from "../jira/namespacedLabels";
import {
  decideGrowth,
  type GrowthProposal,
  type GrowthDecision,
} from "../catalog/catalogGrowth";

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
  /**
   * Optional runtime keyword extensions (compiled by the shell's loader from a
   * gitignored local file). When absent, classification is identical to today.
   */
  extensions?: CategoryExtensions;
  /**
   * Optional HYBRID growth dep (#1387). Fires ONLY when an issue ABSTAINS on the
   * feature axis (`feature === undefined`) AND `grow` is true. Absent / `grow`
   * false → the non-grow path is byte-identical to today (no proposer call, no
   * `proposed-additions` write). The proposer + file I/O live in the shell.
   */
  growth?: GrowthDeps;
}

/**
 * Injected growth dep (#1387). `propose` is the paid model seam (a fake in
 * tests); `existingChildSlugs` is the dedup set (canonical ∪ recorded
 * provisional, MUTATED by `record` so re-runs snap); `bucketIds` is the distinct
 * lean-id set the parent-membership gate validates against; `record` persists a
 * decision to the holding queue. All COUNTS/AXIS-only — never log the candidate.
 */
export interface GrowthDeps {
  propose: (issue: JiraIssue) => Promise<GrowthProposal>;
  existingChildSlugs: Set<string>;
  bucketIds: ReadonlySet<string>;
  threshold?: number;
  minFuzzyLen?: number;
  record: (decision: GrowthDecision, proposal: GrowthProposal) => void;
  grow: boolean;
}

export interface BackfillRunResult {
  /** Issues processed. */
  total: number;
  /** Issues whose assignment passed validation. */
  validated: number;
  /** Issues rejected by validation (all-invalid feature/flow, or bad symptom). */
  rejected: number;
  /** Issues that actually received a mutating PUT (0 in dry-run / on re-run). */
  applied: number;
  /** Issues that validated but had ≥1 member DROPPED (partial validation, #1387). */
  partial: number;
  /** Total feature/flow members dropped as invalid across all issues (#1387). */
  dropped: number;
  /** Provisional children MINTED on the abstain+grow path (#1387). */
  minted: number;
  /** Abstain+grow proposals that SNAPPED to an existing child (#1387). */
  snapped: number;
  /** Abstain+grow proposals routed to the human-approval queue (#1387). */
  proposed: number;
}

export async function run(deps: BackfillRunDeps): Promise<BackfillRunResult> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const apply = deps.apply === true;

  const issues = await deps.fetchOpenDefects();
  let validated = 0;
  let rejected = 0;
  let applied = 0;
  let partial = 0;
  let dropped = 0;
  let minted = 0;
  let snapped = 0;
  let proposed = 0;

  for (const issue of issues) {
    const { category } = categorizeDefect(
      {
        key: issue.key,
        summary: issue.summary,
        descriptionText: issue.descriptionText,
        labels: issue.labels,
        issueType: issue.issueType,
      },
      deps.extensions,
    );
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
    if (target.droppedCount > 0) {
      partial++;
      dropped += target.droppedCount;
    }

    // HYBRID growth (#1387): ONLY on a feature-axis abstain AND opt-in `grow`.
    // Fires in dry-run too (previews + records to the holding queue; no Jira
    // write unless `apply`). Default path (no growth dep / grow false) is inert.
    if (deps.growth?.grow && ff.feature === undefined) {
      const proposal = await deps.growth.propose(issue);
      const decision = decideGrowth(proposal, {
        existingChildSlugs: deps.growth.existingChildSlugs,
        bucketIds: deps.growth.bucketIds,
        threshold: deps.growth.threshold,
        minFuzzyLen: deps.growth.minFuzzyLen,
      });
      switch (decision.kind) {
        case "mint":
          // MED-1: ride the typed `provisionalAdds` so the writer emits them.
          target = withProvisionalChild(target, decision.slug, decision.parentLeanId);
          minted++;
          log("growth: minted 1 provisional child");
          deps.growth.record(decision, proposal);
          break;
        case "snap":
          // Reuse the existing child; mint NOTHING, write NOTHING new.
          snapped++;
          log("growth: snapped 1 candidate to an existing child");
          break;
        case "queue-parent":
          proposed++;
          log("growth: 1 hallucinated/no-fit parent proposal queued for human review");
          deps.growth.record(decision, proposal);
          break;
        case "queue-child":
          proposed++;
          log("growth: 1 low-confidence child proposal queued for human review");
          deps.growth.record(decision, proposal);
          break;
      }
    }

    if (apply && deps.writer && issue.key) {
      const didPut = await deps.writer.applyLabels(issue.key, issue.labels ?? [], target);
      if (didPut) applied++;
    }
  }

  log(
    `backfill: total=${issues.length} validated=${validated} rejected=${rejected} ` +
      `applied=${applied} partial=${partial} dropped=${dropped} ` +
      `minted=${minted} snapped=${snapped} proposed=${proposed} ` +
      `(${apply ? "APPLY" : "dry-run"})`,
  );

  return {
    total: issues.length,
    validated,
    rejected,
    applied,
    partial,
    dropped,
    minted,
    snapped,
    proposed,
  };
}

/**
 * Raised when one or more requested `--keys` are NOT present in the fetched
 * open-defects set (S1, #1342). A typo'd / lowercase / already-closed key must
 * FAIL LOUD — never silently no-op — because `--keys` drives a LIVE add→delete
 * smoke and a zero-touch "success" would be a dangerous false-green. Carries the
 * COUNT only (never the key values) so the structured error stays privacy-safe.
 */
export class UnmatchedUnstampKeysError extends Error {
  constructor(public readonly count: number) {
    super(
      `unstamp: ${count} requested --keys had no match in the fetched open-defects set ` +
        `(typo / wrong case / already-closed?) — refusing to run`,
    );
    this.name = "UnmatchedUnstampKeysError";
  }
}

/** Injected deps for the UNSTAMP core (remove ALL bot labels). */
export interface UnstampRunDeps {
  /** Injected open-defects read. */
  fetchOpenDefects: () => Promise<JiraIssue[]>;
  /** Injected writer — constructed by the shell ONLY on `--apply`. */
  writer?: JiraNamespacedLabelWriter;
  /** Real-write flag. Default false (dry-run). */
  apply?: boolean;
  /**
   * Optional scoping: restrict the run to EXACTLY these issue keys (client-side
   * filter over the fetched open set). An unmatched key throws
   * `UnmatchedUnstampKeysError` (S1 fail-loud). Empty / undefined → full sweep.
   */
  keys?: string[];
  /**
   * Optional restricted peel set (#1387, `--peel-provisional`): peel ONLY these
   * namespace prefixes instead of every bot namespace. Absent → full bot-label
   * peel (default `NS_PREFIXES`).
   */
  peelPrefixes?: readonly string[];
  /** Logger sink; defaults to `console.log`. */
  log?: (msg: string) => void;
}

export interface UnstampRunResult {
  /** Issues in scope (after the optional `--keys` filter). */
  total: number;
  /** Issues carrying ≥1 bot label (would be / were peeled). */
  removable: number;
  /** Issues that actually received a remove-PUT (0 in dry-run / on a clean set). */
  removed: number;
}

/**
 * UNSTAMP core (#1342) — fetch open defects, optionally scope to `deps.keys`,
 * compute the bot-namespace REMOVE ops per issue, and (only with `apply` +
 * `writer`) issue the remove-PUT. Mirrors `run`'s dry-run-default +
 * writer-optional + counts-result contract. Logs COUNTS/STRUCTURE only.
 *
 * Dry-run is the DEFAULT: with `apply !== true` (or no writer) it computes +
 * previews and issues ZERO writes. `removed` counts only issues that actually
 * received a mutating PUT — an issue with no bot labels produces an empty op
 * list → NO PUT → does NOT increment `removed` (the idempotency guarantee).
 */
export async function runUnstamp(deps: UnstampRunDeps): Promise<UnstampRunResult> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const apply = deps.apply === true;

  const issues = await deps.fetchOpenDefects();

  let scoped = issues;
  if (deps.keys && deps.keys.length > 0) {
    const fetchedKeys = new Set(issues.map((i) => i.key));
    // S1 fail-loud: an EXACT-match miss (typo / wrong case / already-closed)
    // must abort, not silently touch zero issues.
    const unmatched = deps.keys.filter((k) => !fetchedKeys.has(k));
    if (unmatched.length > 0) {
      log(
        `unstamp: ABORT — ${unmatched.length} requested key(s) not in the fetched ` +
          `open-defects set (count only; values withheld)`,
      );
      throw new UnmatchedUnstampKeysError(unmatched.length);
    }
    const wanted = new Set(deps.keys);
    scoped = issues.filter((i) => wanted.has(i.key));
  }

  let removable = 0;
  let removed = 0;
  for (const issue of scoped) {
    const ops = computeUnstampOps(issue.labels ?? [], deps.peelPrefixes);
    if (ops.length === 0) continue; // no matching bot labels — nothing to peel.
    removable++;
    if (apply && deps.writer && issue.key) {
      const didPut = await deps.writer.unstampLabels(
        issue.key,
        issue.labels ?? [],
        deps.peelPrefixes,
      );
      if (didPut) removed++;
    }
  }

  log(
    `unstamp: total=${scoped.length} removable=${removable} removed=${removed} ` +
      `(${apply ? "APPLY" : "dry-run"})`,
  );

  return { total: scoped.length, removable, removed };
}
