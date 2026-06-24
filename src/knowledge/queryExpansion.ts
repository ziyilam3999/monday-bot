/**
 * Lever 1 — rule-based query expansion for geo/availability intent (#1191).
 *
 * Problem: a natural geo/availability question ("which places have the
 * service") uses everyday words ("places", "where", "available"), while the
 * answer doc speaks the vocabulary of a launch/market roadmap ("markets",
 * "regions", "launch", "expansion"). That vocabulary mismatch sinks the answer
 * doc far below keyword decoys under the bi-encoder.
 *
 * Fix: detect geo/availability INTENT (a CLOSED, unit-tested signal set — the
 * CLASS, not one literal word), and when detected APPEND a deduped synonym set
 * to the query string before embedding. The query vector then moves toward the
 * doc's "markets/regions/launch" vocabulary — exactly the geo-explicit phrasing
 * that already ranks the doc near the top.
 *
 * Deterministic and dependency-free: a golden eval needs determinism, and this
 * lever class is narrow, so an LLM rewrite would only add cost + non-determinism.
 *
 * Correction #3 (plan-review): the signal set is a CLOSED list and deliberately
 * EXCLUDES over-generic tokens (`service`, `open`, `support`) that would
 * over-trigger expansion on non-geo queries. Non-geo queries pass through
 * BYTE-UNCHANGED (tested).
 */

export interface QueryExpansionConfig {
  /** Default true. When false, expandQuery is an identity function. */
  enabled?: boolean;
}

/**
 * CLOSED geo/availability intent signal set. Lowercased whole-word tokens.
 * Deliberately tight: generic words like `service`, `open`, `support` are
 * EXCLUDED (correction #3) because they would flip non-geo queries
 * ("is the X service available?", "office open hours") into expansion.
 *
 * If you add a token here, add a coverage case to recall-expansion.test.ts AND
 * confirm it does not appear in any existing test query.
 */
export const GEO_INTENT_SIGNALS: ReadonlySet<string> = new Set([
  "places",
  "place",
  "location",
  "locations",
  "where",
  "available",
  "availability",
  "offered",
  "country",
  "countries",
  "region",
  "regions",
  "city",
  "cities",
  "market",
  "markets",
  "coverage",
  "launch",
  "launched",
  "expansion",
  "rollout",
]);

/**
 * Synonym set appended to a geo-intent query. Pulls the query vector toward the
 * launch/market-roadmap vocabulary the answer doc actually uses. Deduped against
 * the question's own tokens at call time so we never double-weight a word the
 * user already typed.
 */
export const GEO_EXPANSION_TERMS: readonly string[] = [
  "countries",
  "regions",
  "cities",
  "coverage",
  "markets",
  "locations",
  "launch",
  "expansion",
  "availability",
  "rollout",
];

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? []);
}

/**
 * Return true when the question carries geo/availability intent (any token is
 * in the CLOSED signal set). Pure + deterministic.
 */
export function hasGeoIntent(question: string): boolean {
  if (typeof question !== "string") return false;
  for (const tok of tokenize(question)) {
    if (GEO_INTENT_SIGNALS.has(tok)) return true;
  }
  return false;
}

/**
 * Expand a geo/availability question with launch/market vocabulary. Returns the
 * input UNCHANGED when expansion is disabled or the question is non-geo.
 *
 * When expanding, appends only the synonym terms NOT already present in the
 * question (dedup), preserving the original question text verbatim at the front.
 */
export function expandQuery(
  question: string,
  cfg?: QueryExpansionConfig,
): string {
  if (typeof question !== "string") return question;
  const enabled = cfg?.enabled ?? true;
  if (!enabled) return question;
  if (!hasGeoIntent(question)) return question;

  const present = new Set(tokenize(question));
  const additions = GEO_EXPANSION_TERMS.filter((t) => !present.has(t));
  if (additions.length === 0) return question;
  return `${question} ${additions.join(" ")}`;
}
