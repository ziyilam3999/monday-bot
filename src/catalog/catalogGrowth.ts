/**
 * Pure, I/O-free catalog-growth core (#1387).
 *
 * When the matcher abstains (can't confidently place a defect into the canonical
 * catalog) AND the operator opted in (`--grow`), the proposer suggests a NEW
 * child under an EXISTING bucket. This module is the SAFETY heart of growth:
 *
 *   1. PARENT-MEMBERSHIP gate (MED-4 — runs FIRST): the model's `parentLeanId`
 *      is UNTRUSTED. Any non-member / null parent routes to a human-approval
 *      queue and is NEVER written — code can NEVER auto-create a parent.
 *   2. DEDUP / similarity guard: only a member parent reaches here. A candidate
 *      that is basically the same as an existing child SNAPS to it (mints
 *      nothing); a short slug only snaps on an EXACT match (the MIN-LENGTH
 *      guard, MED-3); otherwise a high-confidence candidate MINTS a provisional.
 *
 * No fs / network / model here — unit-tested with synthetic data only.
 */
import { slug } from "./slug";

/**
 * The proposer's verdict for one abstaining issue. `parentLeanId` is the lean
 * bucket id the model picked (or null); `candidateLabel` is the human-readable
 * child label it proposes. UNTRUSTED until validated here.
 */
export interface GrowthProposal {
  parentLeanId: string | null;
  candidateLabel: string;
  confidence: "high" | "low";
}

/**
 * Source default snap threshold + short-slug fuzzy floor.
 * PROVISIONAL — pending empirical calibration (MED-3). `0.85` is a starting
 * guess, NOT a tuned value; override at runtime via `--snap-threshold` / the
 * `MONDAY_GROWTH_SNAP_THRESHOLD` env. `GROWTH_MIN_FUZZY_LEN` stops the threshold
 * over-snapping tiny slugs (e.g. `api` ↔ `ami`).
 */
export const GROWTH_SNAP_THRESHOLD = 0.85; // PROVISIONAL — pending empirical calibration.
export const GROWTH_MIN_FUZZY_LEN = 6; // PROVISIONAL — pending empirical calibration.

/** Levenshtein edit distance between two strings (iterative two-row DP). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * Normalized Levenshtein similarity in `[0,1]` over the two slugs (1 = identical,
 * 0 = maximally different). The `similarity?` seam in `dedupCandidate` defaults
 * to this — an embedding-cosine backend can swap in later without touching call
 * sites.
 */
export function slugSimilarity(a: string, b: string): number {
  const sa = slug(a);
  const sb = slug(b);
  if (sa === sb) return 1;
  const maxLen = Math.max(sa.length, sb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(sa, sb) / maxLen;
}

/**
 * PURE precedence resolver for the snap threshold (MED-3): `flag` > `env`
 * (`MONDAY_GROWTH_SNAP_THRESHOLD`) > source default `GROWTH_SNAP_THRESHOLD`. A
 * value is honored only if it is a finite number in `(0,1]`; an out-of-range /
 * unparseable override is IGNORED and the next precedence level is used. Reads
 * `process.env` only when `env` is not explicitly supplied (so unit tests stay
 * env-free).
 */
export function resolveSnapThreshold(
  opts: { flag?: number; env?: string } = {},
): number {
  const usable = (n: number | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1;

  if (usable(opts.flag)) return opts.flag;

  const envRaw = "env" in opts ? opts.env : process.env.MONDAY_GROWTH_SNAP_THRESHOLD;
  if (envRaw !== undefined && envRaw !== "") {
    const envNum = Number(envRaw);
    if (usable(envNum)) return envNum;
  }
  return GROWTH_SNAP_THRESHOLD;
}

export type DedupResult =
  | { action: "snap"; childId: string }
  | { action: "mint"; slug: string };

export interface DedupOptions {
  threshold?: number;
  minFuzzyLen?: number;
  similarity?: (a: string, b: string) => number;
}

/**
 * Decide whether a candidate child SNAPS to an existing child or MINTS a new
 * slug. EXACT slug match always snaps. Below `minFuzzyLen` (MED-3) only an exact
 * match snaps — fuzzy is disabled so tiny slugs aren't over-snapped. Otherwise
 * the most-similar existing child SNAPS when `sim >= threshold`; else MINT.
 */
export function dedupCandidate(
  candidateLabel: string,
  existingChildSlugs: Iterable<string>,
  opts: DedupOptions = {},
): DedupResult {
  const s = slug(candidateLabel);
  const threshold = opts.threshold ?? GROWTH_SNAP_THRESHOLD;
  const minFuzzyLen = opts.minFuzzyLen ?? GROWTH_MIN_FUZZY_LEN;
  const sim = opts.similarity ?? slugSimilarity;
  const existing = [...existingChildSlugs];

  // EXACT match always snaps (covers the short-slug exact case too).
  for (const e of existing) {
    if (slug(e) === s) return { action: "snap", childId: e };
  }

  // Short-slug MIN-LENGTH guard: below the floor, fuzzy is OFF → mint.
  if (s.length < minFuzzyLen) return { action: "mint", slug: s };

  let best: { childId: string; sim: number } = { childId: "", sim: 0 };
  for (const e of existing) {
    const score = sim(s, slug(e));
    if (score > best.sim) best = { childId: e, sim: score };
  }
  if (best.sim >= threshold) return { action: "snap", childId: best.childId };
  return { action: "mint", slug: s };
}

export type GrowthDecision =
  | { kind: "snap"; childId: string }
  | { kind: "mint"; slug: string; parentLeanId: string }
  | { kind: "queue-child"; slug: string; parentLeanId: string }
  | { kind: "queue-parent"; slug: string; reason: "hallucinated-parent" | "no-bucket-fit" };

export interface DecideGrowthDeps {
  existingChildSlugs: Iterable<string>;
  bucketIds: ReadonlySet<string> | Iterable<string>;
  threshold?: number;
  minFuzzyLen?: number;
  similarity?: (a: string, b: string) => number;
}

/**
 * Top-level growth decision for ONE abstaining issue (#1387).
 *
 * Order is load-bearing (MED-4): VALIDATE `parentLeanId ∈ bucketIds` FIRST. A
 * null parent → `queue-parent` (`no-bucket-fit`); a NON-member parent →
 * `queue-parent` (`hallucinated-parent`) — both go to the human queue, NEVER
 * written, even when the candidate child is dissimilar + high-confidence. Only a
 * MEMBER parent proceeds to dedup: an existing child SNAPS; otherwise a
 * high-confidence candidate MINTS, a low-confidence one → `queue-child`.
 */
export function decideGrowth(
  proposal: GrowthProposal,
  deps: DecideGrowthDeps,
): GrowthDecision {
  const s = slug(proposal.candidateLabel);

  // 1. PARENT-MEMBERSHIP gate FIRST — code can never auto-create a parent.
  if (proposal.parentLeanId === null) {
    return { kind: "queue-parent", slug: s, reason: "no-bucket-fit" };
  }
  const bucketSet =
    deps.bucketIds instanceof Set ? deps.bucketIds : new Set(deps.bucketIds);
  if (!bucketSet.has(proposal.parentLeanId)) {
    return { kind: "queue-parent", slug: s, reason: "hallucinated-parent" };
  }

  // 2. Member parent → dedup. An existing child snaps (safe regardless of conf).
  const dedup = dedupCandidate(proposal.candidateLabel, deps.existingChildSlugs, {
    threshold: deps.threshold,
    minFuzzyLen: deps.minFuzzyLen,
    similarity: deps.similarity,
  });
  if (dedup.action === "snap") return { kind: "snap", childId: dedup.childId };

  // 3. Mint path — gate on confidence. Low confidence → queue, never mint.
  if (proposal.confidence === "low") {
    return { kind: "queue-child", slug: s, parentLeanId: proposal.parentLeanId };
  }
  return { kind: "mint", slug: s, parentLeanId: proposal.parentLeanId };
}
