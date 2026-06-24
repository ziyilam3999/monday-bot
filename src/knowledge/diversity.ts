/**
 * Lever 3 — per-source-type diversity cap (#1191).
 *
 * Problem (Q5 class): a how-to page IS near the top, but a swarm of short
 * keyword-dense issue tickets from ONE source type monopolizes every top slot,
 * pushing the how-to page out of the returned window.
 *
 * Fix: cap how many results any single SOURCE TYPE may take in the returned
 * window, then back-fill remaining slots from the overflow in rank order so we
 * never return fewer than `min(topK, pool)` results. The cap RESHUFFLES; it
 * never STARVES — on a homogeneous (single source-type) corpus it returns the
 * identical top-K set in rank order (emit `maxPerType`, then back-fill the next
 * in rank order).
 *
 * Pure + deterministic — no model, no I/O.
 */

export interface DiversityCapConfig {
  /** Default true. When false, applyDiversityCap is an identity slice. */
  enabled?: boolean;
  /** Max results any one source-type may take. Default 6 (half of topK=12). */
  maxPerSourceType?: number;
}

/** Minimal shape the cap needs: just a `source` string. */
export interface HasSource {
  source: string;
}

/**
 * Derive a source-TYPE token from a chunk `source` string.
 *  - `confluence:page-1`  -> `confluence`
 *  - `jira:ISSUE-1`       -> `jira`
 *  - `/abs/path/file.md`  -> `local-file` (filesystem paths have no scheme)
 *
 * Absolute paths (leading `/`) are classed `local-file` BEFORE the colon check
 * so a Windows-style `C:\...` or a path containing a colon is not mis-split.
 */
export function sourceType(source: string): string {
  if (typeof source !== "string" || source.length === 0) return "local-file";
  if (source.startsWith("/")) return "local-file";
  const idx = source.indexOf(":");
  if (idx > 0) return source.slice(0, idx).toLowerCase();
  return "local-file";
}

/**
 * Apply the per-source-type diversity cap and return up to `topK` results.
 *
 * Algorithm: walk results in rank order. Emit each into the primary list while
 * its source-type is still under `maxPerType`; otherwise hold it in overflow.
 * Then back-fill from overflow (still in rank order) until we have `topK` items
 * or run out. This guarantees:
 *   - no source-type exceeds `maxPerType` UNTIL back-fill is forced (never starve);
 *   - a homogeneous corpus returns the identical rank-ordered top-K;
 *   - total returned = `min(topK, results.length)`.
 *
 * When `cfg.enabled === false`, this is a plain `results.slice(0, topK)` — i.e.
 * byte-identical to the no-cap path.
 *
 * NOTE: to read the FULL reordered ranking (e.g. an eval measuring a target's
 * rank even when it lands outside the production window), call with a `topK`
 * >= results.length — back-fill then appends ALL overflow, yielding the
 * complete cap-prioritized order.
 */
export function applyDiversityCap<T extends HasSource>(
  results: T[],
  topK: number,
  cfg?: DiversityCapConfig,
): T[] {
  if (!Array.isArray(results)) return [];
  const limit = Math.max(0, topK);
  const enabled = cfg?.enabled ?? true;
  if (!enabled) return results.slice(0, limit);

  const maxPerType = Math.max(1, cfg?.maxPerSourceType ?? 6);

  const primary: T[] = [];
  const overflow: T[] = [];
  const counts = new Map<string, number>();

  for (const r of results) {
    const type = sourceType(r.source);
    const used = counts.get(type) ?? 0;
    if (used < maxPerType) {
      primary.push(r);
      counts.set(type, used + 1);
    } else {
      overflow.push(r);
    }
  }

  const out = primary.slice(0, limit);
  for (let i = 0; out.length < limit && i < overflow.length; i++) {
    out.push(overflow[i]);
  }
  return out;
}
