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
  const corpusIds = new Set(pages.map((p) => p.id));

  const raw = await deps.distiller.distill(pages);
  const rawFeatures = Array.isArray(raw?.features) ? raw.features : [];
  const rawFlows = Array.isArray(raw?.flows) ? raw.flows : [];

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
