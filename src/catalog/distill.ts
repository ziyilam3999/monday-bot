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
 * 2. Assign a stable id `<prefix>-<slug(label)>` (empty slugs fall back to a
 *    sentinel so they remain addressable).
 * 3. Dedup: entries that slug to the SAME id are the same feature/flow — merge
 *    them, UNIONing their provenance (insertion-ordered, de-duplicated). Because
 *    same-slug entries merge here, the surviving id space is collision-free by
 *    construction, so no numeric `-2`/`-3` disambiguation is needed.
 * 4. Sort by id ascending for deterministic output.
 */
function buildEntries(
  raw: RawCatalogEntry[],
  prefix: "feature" | "flow",
  corpusIds: ReadonlySet<string>,
): CatalogEntry[] {
  // Map keyed by slug -> merged entry (preserves first-seen label deterministically).
  const bySlug = new Map<string, { label: string; provenance: string[] }>();

  for (const entry of raw) {
    const provenance = (entry.provenancePageIds ?? []).filter((id) => corpusIds.has(id));
    // Drop entries with zero valid provenance (AC-PROVENANCE-PRUNE).
    if (provenance.length === 0) continue;

    const s = slug(entry.label) || "entry";
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
