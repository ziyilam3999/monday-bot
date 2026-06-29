import {
  CatalogDistiller,
  CatalogEntry,
  CatalogPage,
  FeatureCatalog,
  RawCatalogEntry,
} from "./types";
import { slug } from "./slug";

/**
 * Pure, injectable distill core (#1314 S2).
 *
 * Takes the corpus pages + an injected `CatalogDistiller`, and returns a
 * validated `FeatureCatalog`. The ONLY effectful thing it does is call
 * `deps.distiller.distill(pages)` (stubbed in tests). Everything after that is
 * deterministic, in-memory transformation: provenance validation, stable id
 * assignment, dedup, and a stable sort. NO network, NO fs, NO creds.
 */
export interface DistillDeps {
  distiller: CatalogDistiller;
  /** Injectable clock for deterministic `generatedAt` in tests. */
  now?: () => number;
  /**
   * Per-batch token budget for the map-reduce split (#1378). Defaults to
   * `DEFAULT_BATCH_TOKEN_BUDGET`. The production shell threads the
   * `CATALOG_BATCH_TOKEN_BUDGET` env override through here; tests inject a TINY
   * budget to force multi-batch splits without huge fixtures.
   */
  batchTokenBudget?: number;
  /** Chars-per-token estimate divisor. Defaults to `DEFAULT_CHARS_PER_TOKEN`. */
  charsPerToken?: number;
  /**
   * Counts/structure-only logger. Defaults to a no-op when undefined (never
   * crash on a missing logger). NEVER receives a label / title / body / id.
   */
  log?: (msg: string) => void;
}

/**
 * Default per-batch token budget (#1378). Safely under the model's 200k hard
 * input limit, leaving margin for the instructions prompt + the `max_tokens`
 * output reservation. CONFIGURABLE — overridable via `deps.batchTokenBudget`
 * and, in the production shell, the `CATALOG_BATCH_TOKEN_BUDGET` env var
 * (parsed + threaded in `scripts/build-catalog.js`; the pure module never reads
 * `process.env`). This named const — NOT a bare literal — is the sole source of
 * the default value (MEMORY: feedback_configurable_parameters_not_hardcoded).
 */
export const DEFAULT_BATCH_TOKEN_BUDGET = 150000;

/** Default chars-per-token divisor for the deterministic size estimate. */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Fixed per-page serialization overhead (chars) — the `### PAGE id=… title=…`
 * wrapper + separators the production distiller adds around each page body.
 * Folded into the size estimate so packing matches the real serialized cost.
 */
export const PER_PAGE_OVERHEAD_CHARS = 32;

/**
 * Deterministic, tokenizer-free size estimate for one page: the way the
 * production distiller serializes it (`### PAGE id=… title=…\n<body>`),
 * approximated as chars/charsPerToken. Fully deterministic (re-run stability is
 * an AC).
 */
function estTokens(page: CatalogPage, charsPerToken: number): number {
  const chars = page.id.length + page.title.length + page.body.length + PER_PAGE_OVERHEAD_CHARS;
  return Math.ceil(chars / charsPerToken);
}

/**
 * Greedy bin-pack pages IN INPUT ORDER under `budget` (estimated tokens).
 * Page order is never reordered (determinism). A page whose own estimate
 * exceeds the budget has already been truncated upstream to fit, so it lands in
 * its own batch here.
 */
function packBatches(
  pages: CatalogPage[],
  budget: number,
  charsPerToken: number,
): CatalogPage[][] {
  const batches: CatalogPage[][] = [];
  let current: CatalogPage[] = [];
  let currentTokens = 0;
  for (const page of pages) {
    const est = estTokens(page, charsPerToken);
    // Starting a new batch when adding this page would overflow a non-empty one.
    if (current.length > 0 && currentTokens + est > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(page);
    currentTokens += est;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Turn raw distiller entries of ONE kind (features OR flows) into validated,
 * id-stamped, deduped, sorted `CatalogEntry[]`.
 *
 * 1. Validate provenance: keep only ids present in the corpus; drop entries
 *    left with zero valid provenance ids.
 * 2. Assign a stable id `<prefix>-<slug(label)>`. Labels that normalize to an
 *    EMPTY slug (symbols-only, emoji-only, whitespace-only) fall back to an
 *    `entry` sentinel so they stay addressable — but DISTINCT empty-normalizing
 *    labels are disambiguated (`entry`, `entry-2`, …) so two different junk
 *    labels do NOT silently collapse into one (collision becomes detectable).
 * 3. Dedup: NON-empty entries that slug to the SAME id are the same feature/flow
 *    — merge them, UNIONing their provenance (insertion-ordered, de-duplicated).
 *    An identical empty-normalizing label still merges with itself; only DISTINCT
 *    empty-normalizing labels are kept apart.
 * 4. Sort by id ascending for deterministic output.
 */
function buildEntries(
  raw: RawCatalogEntry[],
  prefix: "feature" | "flow",
  corpusIds: ReadonlySet<string>,
): CatalogEntry[] {
  // Map keyed by slug -> merged entry (preserves first-seen label deterministically).
  const bySlug = new Map<string, { label: string; provenance: string[] }>();
  // Empty-normalizing labels (slug() -> "") share the `entry` fallback. Key them
  // by their ORIGINAL label so an identical junk label still merges with itself,
  // while DISTINCT junk labels each get a deterministic, detectable id
  // (`entry`, `entry-2`, …) instead of silently collapsing into one entry.
  const emptyLabelToSlug = new Map<string, string>();

  for (const entry of raw) {
    const provenance = (entry.provenancePageIds ?? []).filter((id) => corpusIds.has(id));
    // Drop entries with zero valid provenance (AC-PROVENANCE-PRUNE).
    if (provenance.length === 0) continue;

    const normalized = slug(entry.label);
    let s: string;
    if (normalized) {
      s = normalized;
    } else {
      let fallback = emptyLabelToSlug.get(entry.label);
      if (fallback === undefined) {
        const n = emptyLabelToSlug.size;
        fallback = n === 0 ? "entry" : `entry-${n + 1}`;
        emptyLabelToSlug.set(entry.label, fallback);
      }
      s = fallback;
    }
    const existing = bySlug.get(s);
    if (existing) {
      // Dedup: union provenance, keeping insertion order without duplicates.
      for (const id of provenance) {
        if (!existing.provenance.includes(id)) existing.provenance.push(id);
      }
    } else {
      // De-duplicate provenance within a single entry too.
      const seeded: string[] = [];
      for (const id of provenance) {
        if (!seeded.includes(id)) seeded.push(id);
      }
      bySlug.set(s, { label: entry.label, provenance: seeded });
    }
  }

  const entries: CatalogEntry[] = [];
  for (const [s, merged] of bySlug) {
    entries.push({
      id: `${prefix}-${s}`,
      label: merged.label,
      provenancePageIds: merged.provenance,
    });
  }

  // Deterministic order (re-run stability is an AC).
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}

/**
 * Distill a `FeatureCatalog` from the corpus pages using the injected distiller.
 * `reviewed` is always `false` — the operator flips it after hand-editing.
 */
export async function distillCatalog(
  pages: CatalogPage[],
  deps: DistillDeps,
): Promise<FeatureCatalog> {
  if (!deps || !deps.distiller || typeof deps.distiller.distill !== "function") {
    throw new TypeError("distillCatalog: deps.distiller with a distill() method is required");
  }
  // Default a no-op logger so a missing sink never crashes the pure module.
  const log = deps.log ?? (() => undefined);
  const budget =
    typeof deps.batchTokenBudget === "number" && deps.batchTokenBudget > 0
      ? deps.batchTokenBudget
      : DEFAULT_BATCH_TOKEN_BUDGET;
  const charsPerToken =
    typeof deps.charsPerToken === "number" && deps.charsPerToken > 0
      ? deps.charsPerToken
      : DEFAULT_CHARS_PER_TOKEN;

  // corpusIds is built from the FULL ORIGINAL corpus so post-distill provenance
  // validation in buildEntries() is unaffected by any truncation below.
  const corpusIds = new Set(pages.map((p) => p.id));

  // A page whose own estimate exceeds the budget cannot fit in any batch.
  // TRUNCATE its body on a COPY (never mutate input, never silently drop): keep
  // the head up to a budget-DERIVED char cap so the page still participates
  // (its id, head content, and provenance survive). Count only — no label /
  // title / body / id is ever logged (privacy: the catalog carries internal
  // product names).
  let truncatedCount = 0;
  const processed: CatalogPage[] = pages.map((page) => {
    if (estTokens(page, charsPerToken) <= budget) return page;
    truncatedCount += 1;
    const maxBodyChars = Math.max(
      0,
      budget * charsPerToken - PER_PAGE_OVERHEAD_CHARS - page.id.length - page.title.length,
    );
    return { ...page, body: page.body.slice(0, maxBodyChars) };
  });

  const batches = packBatches(processed, budget, charsPerToken);
  log(`Distilling corpus in ${batches.length} batch(es).`);
  if (truncatedCount > 0) {
    log(
      `WARN: ${truncatedCount} page(s) exceeded the per-batch token budget and were ` +
        `truncated (content preserved up to the budget; nothing dropped from the catalog).`,
    );
  }

  // Map: one distiller call PER BATCH. Reduce: concatenate the per-batch raw
  // arrays IN BATCH ORDER, then hand the concatenation to the existing
  // buildEntries() (which dedups-by-id, unions provenance first-wins-label, and
  // validates against the full corpus — unchanged).
  const rawFeatures: RawCatalogEntry[] = [];
  const rawFlows: RawCatalogEntry[] = [];
  for (const batch of batches) {
    const raw = await deps.distiller.distill(batch);
    if (Array.isArray(raw?.features)) rawFeatures.push(...raw.features);
    if (Array.isArray(raw?.flows)) rawFlows.push(...raw.flows);
  }

  const features = buildEntries(rawFeatures, "feature", corpusIds);
  const flows = buildEntries(rawFlows, "flow", corpusIds);

  const nowMs = deps.now ? deps.now() : Date.now();
  return {
    generatedAt: new Date(nowMs).toISOString(),
    reviewed: false,
    features,
    flows,
  };
}
