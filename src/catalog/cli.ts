import { distillCatalog } from "./distill";
import { CatalogDistiller, CatalogPage, FeatureCatalog } from "./types";

/**
 * Injectable CLI core for the catalog tooling (#1314 S2).
 *
 * Orchestrates ingest -> distill -> write. Both effectful seams are INJECTED:
 *   - `fetchPages` is the bound method of the REUSED `src/confluence/sync.ts`
 *     fetcher (production) or a stub (tests). NO pagination/endpoint logic lives
 *     here — that stays in `src/confluence/sync.ts` (fixed #1309).
 *   - `distiller` is the single LLM boundary; a fake in tests means ZERO network.
 *   - `writeCatalog` is the sink: fs in the shell, in-memory in tests.
 *
 * The logger emits COUNTS/STRUCTURE ONLY — never a label, body, page id, space
 * key, host, or email. The catalog (which carries internal product names) is
 * written ONLY to the gitignored sink.
 */
export interface CatalogRunDeps {
  /** Injected Confluence fetch (the reused fetcher's bound `fetchPages`). */
  fetchPages: (spaceKey: string) => Promise<CatalogPage[]>;
  /** Injected single LLM boundary. */
  distiller: CatalogDistiller;
  /** Injected sink — writes the gitignored file (shell) / captures in memory (test). */
  writeCatalog: (catalog: FeatureCatalog) => Promise<void>;
  /** Confluence space key to ingest. */
  spaceKey: string;
  /** Injectable clock for deterministic `generatedAt`. */
  now?: () => number;
  /** Counts/structure-only logger sink; defaults to `console.log`. */
  log?: (msg: string) => void;
  /**
   * Optional per-batch token budget for the distill map-reduce (#1378). When
   * set, threaded into `distillCatalog`; otherwise the module default applies.
   * The shell derives this from `CATALOG_BATCH_TOKEN_BUDGET`.
   */
  batchTokenBudget?: number;
  /** Optional chars-per-token estimate override (from `CATALOG_CHARS_PER_TOKEN`). */
  charsPerToken?: number;
}

export interface CatalogRunResult {
  featureCount: number;
  flowCount: number;
  pagesIngested: number;
}

/**
 * Gitignored output path (under the already-gitignored `.ai-workspace/`). The
 * shell derives its real write target from THIS constant, and AC-GITIGNORED
 * asserts `git check-ignore` on it (N1) — so the AC tracks the real path the
 * tool writes, not a drifting literal.
 */
export const CATALOG_OUTPUT_PATH = ".ai-workspace/catalog/feature-catalog.json";

/**
 * No-clobber sibling: when the operator already has an edited catalog at
 * `CATALOG_OUTPUT_PATH`, a regenerate writes HERE instead so operator edits are
 * never overwritten (they diff, then adopt).
 */
export const CATALOG_REGENERATED_PATH = ".ai-workspace/catalog/feature-catalog.regenerated.json";

/**
 * Pure path-picker for the no-clobber guard: write to the regenerated sibling if
 * the primary output already exists, else to the primary. Extracted so the
 * guard is unit-testable without touching the real filesystem.
 */
export function chooseWritePath(
  outputPath: string,
  regeneratedPath: string,
  exists: (p: string) => boolean,
): string {
  return exists(outputPath) ? regeneratedPath : outputPath;
}

export async function run(deps: CatalogRunDeps): Promise<CatalogRunResult> {
  const log = deps.log ?? ((msg: string) => console.log(msg));

  if (typeof deps.spaceKey !== "string" || deps.spaceKey.length === 0) {
    throw new TypeError("catalog run: deps.spaceKey must be a non-empty string");
  }

  // 1. Ingest via the injected (reused) fetcher — no pagination logic here.
  const pages = await deps.fetchPages(deps.spaceKey);
  log(`Ingested ${pages.length} pages.`);

  // 2. Distill (the per-batch LLM calls live inside the injected distiller).
  //    The batch-count + truncation warnings reach the counts-only sink.
  const catalog = await distillCatalog(pages, {
    distiller: deps.distiller,
    now: deps.now,
    log,
    batchTokenBudget: deps.batchTokenBudget,
    charsPerToken: deps.charsPerToken,
  });

  // 3. Write the gitignored catalog via the injected sink.
  await deps.writeCatalog(catalog);

  // 4. Log COUNTS/STRUCTURE ONLY — never a label, body, id, space key, host, email.
  log(`Distilled ${catalog.features.length} features, ${catalog.flows.length} flows.`);
  log(
    `Catalog written to ${CATALOG_OUTPUT_PATH} (gitignored). Open it to review/edit, ` +
      `then flip "reviewed": true.`,
  );

  return {
    featureCount: catalog.features.length,
    flowCount: catalog.flows.length,
    pagesIngested: pages.length,
  };
}
