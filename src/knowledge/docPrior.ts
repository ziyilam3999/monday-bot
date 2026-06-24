/**
 * Lever 4 — how-to-action doc-over-ticket ranking prior (#1197).
 *
 * Problem (the find-parking how-to query class): the bi-encoder hands the LLM a
 * wall of short, keyword-dense issue-tracker (ticket) stubs first, while the
 * user-facing how-to DOC passage that actually explains the mechanism sits just
 * below the window (rank #7 on the real index). The LLM reads only ticket stubs,
 * sees no usable instructions, and abstains. This is a RANKING problem, not a
 * framing one (#1195 proved framing cannot move it).
 *
 * Fix: when — and ONLY when — the question carries how-to-ACTION intent, add a
 * SMALL additive score bonus to narrative-DOC source-types so a how-to page
 * rises above the bare ticket stubs the bi-encoder over-ranked on keyword
 * density. NON-how-to queries pass through UNCHANGED (control-safety: the boost
 * code path never runs for chit-chat / geo / not-in-corpus queries).
 *
 * MECHANISM CHOICE (plan-review correction #1) — minimal additive bonus, NOT the
 * plan's max-aggressive 0.20:
 *   - A pure source-type TIE-BREAK is a no-op here: the bi-encoder scores are
 *     distinct, and the gt-doc (#7) scores BELOW the six tickets above it, so a
 *     secondary tie-break by source-type never fires and cannot lift it. Pure
 *     tie-break rejected on that ground.
 *   - The least-overfit mechanism that reliably grounds the target is therefore
 *     a SMALL additive bonus. The read-only probe sweep showed +0.10 lands the
 *     gt-doc at #3 — INSIDE the #1-3 grounding window — while +0.20 overshoots to
 *     #1 with doc×5 monopolizing the top-6 (the overfit smell: an additive bonus
 *     is tuned to clear THIS query's ticket↔doc gap on THIS index, so a larger
 *     value over-promotes every doc passage by a fixed amount regardless of
 *     relevance). We ship the SMALLEST bonus that lands inside the grounding
 *     window, justified by the Tier-B grounding rate, not "it made Q5 #1".
 *   - The bonus is the single config knob (`bonus`), tunable without code change.
 *
 * The prior reorders only; it never mutates the stored `score`, never adds or
 * removes candidates, and never fires for non-how-to-action intent. Stable
 * re-sort (ties keep input order). Pure + deterministic — no model, no I/O. Runs
 * BEFORE the diversity cap so the cap then shapes the already-prioritized order.
 */

import { sourceType, HasSource } from "./diversity";
import { hasHowToActionIntent } from "./queryExpansion";

export interface DocPriorConfig {
  /** When false, applyDocPrior is identity. Default decided by resolveRecall. */
  enabled?: boolean;
  /**
   * Additive score bonus for narrative-DOC source-types on how-to-action intent.
   * Default 0.10 (the minimal-sufficient value: probe showed it lands the
   * how-to doc inside the #1-3 grounding window — correction #1).
   */
  bonus?: number;
  /** Source-types treated as narrative DOCs (boosted). Default ["confluence"]. */
  docSourceTypes?: readonly string[];
}

/** Minimal-sufficient bonus — lands the how-to doc inside the #1-3 window (#1197). */
export const DEFAULT_DOC_PRIOR_BONUS = 0.1;
export const DEFAULT_DOC_SOURCE_TYPES = ["confluence"] as const;

/**
 * Apply the how-to-action doc-over-ticket prior. When the question carries
 * how-to-action intent, add `bonus` to narrative-DOC passages and stable-re-sort
 * by the adjusted score (ties keep input order). Returns the input UNCHANGED
 * when disabled or when the question is not how-to-action.
 */
export function applyDocPrior<T extends HasSource & { score: number }>(
  question: string,
  results: T[],
  cfg?: DocPriorConfig,
): T[] {
  if (!Array.isArray(results)) return [];
  const enabled = cfg?.enabled ?? true;
  if (!enabled || !hasHowToActionIntent(question)) return results;
  const bonus = cfg?.bonus ?? DEFAULT_DOC_PRIOR_BONUS;
  const docTypes = new Set(cfg?.docSourceTypes ?? DEFAULT_DOC_SOURCE_TYPES);
  return results
    .map((r, idx) => ({
      r,
      idx,
      s: r.score + (docTypes.has(sourceType(r.source)) ? bonus : 0),
    }))
    .sort((a, b) => b.s - a.s || a.idx - b.idx)
    .map((x) => x.r);
}
