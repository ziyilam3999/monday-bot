/**
 * PURE, I/O-free NL→JQL builder (#1332 — Stage C viewing layer).
 *
 * The determinism seam: the FUZZY "English → which labels" step is the LLM's job
 * (`nlFilterMapper`); this module is the EXACT "labels → JQL string" half. It has
 * NO LLM, NO fs, NO network — given the same `(filter, vocab)` it returns a
 * byte-identical `{ jql, warnings }` every time, so the JQL contract can be
 * exhaustively unit-tested and never surprises us.
 *
 * Determinism + injection-safety: every label slug is canonicalised through the
 * ONE shared `slug()` before quoting, and the `labels in (...)` clause is built
 * by the ONE shared `labelsInClause` (sort + dedupe + double-quote) — so weird
 * characters collapse to hyphens and there is no JQL-quoting hazard.
 *
 * Forward-compat (symptom live NOW; feature/flow wired-but-inert): the symptom
 * axis validates HARD against the live taxonomy. The feature/flow axes validate
 * catalog-conditionally — when the gitignored catalog has NOT landed yet
 * (`featureIds`/`flowIds` empty) a requested feature/flow PASSES THROUGH into the
 * JQL (so the clause is correct) plus a warning that it "matches nothing until
 * the deferred matcher runs"; once the catalog lands, an unknown slug is dropped
 * + warned (kills LLM hallucinations). Warnings name the AXIS only, never echo a
 * rejected raw value (mirrors `LabelValidationError` log discipline — PUBLIC repo).
 */
import { slug } from "../catalog/slug";
import { labelsInClause, NS_FEATURE, NS_FLOW, NS_SYMPTOM } from "./namespacedLabels";

/**
 * The structured query the LLM maps an English question to (`nlFilterMapper`),
 * and the PURE builder's input. Each axis is a list of bare slugs (within-axis
 * OR). `extraStatus` is an OPERATOR-ONLY raw status override — the LLM mapper
 * MUST NEVER populate it (see `nlFilterMapper`); the default path is
 * `statusCategory != Done`.
 */
export interface StructuredFilter {
  /** Symptom slugs (validated HARD against the 8-value taxonomy). */
  symptoms: string[];
  /** `mb-feature` slugs (catalog vocab; empty-tolerant / forward-compatible). */
  features: string[];
  /** `mb-flow` slugs (catalog vocab; empty-tolerant / forward-compatible). */
  flows: string[];
  /** Jira project keys, e.g. `["DEMO"]`. */
  projects: string[];
  /** OPERATOR-ONLY raw status clause override. Default = `statusCategory != Done`. */
  extraStatus?: string;
}

/**
 * The legal vocabulary, injected into the builder. Built by `buildVocab` from the
 * symptom taxonomy + the gitignored catalog's entry ids. `featureIds`/`flowIds`
 * may be EMPTY today (catalog not yet populated) — the builder is forward-compatible.
 */
export interface LabelVocab {
  /** The live symptom slugs (the 8-value `DEFECT_CATEGORIES`). */
  symptoms: ReadonlySet<string>;
  /** Catalog feature entry ids (`feature-<slug>`); may be EMPTY today. */
  featureIds: ReadonlySet<string>;
  /** Catalog flow entry ids (`flow-<slug>`); may be EMPTY today. */
  flowIds: ReadonlySet<string>;
}

/** The builder's deterministic output. */
export interface JqlBuildResult {
  jql: string;
  warnings: string[];
}

/** Default open-defects status clause (mirrors `buildOpenDefectsJql`). */
const DEFAULT_STATUS = "statusCategory != Done";

/**
 * Resolve a feature/flow axis against the catalog. Catalog-conditional:
 *   - EMPTY catalog set → every requested slug PASSES THROUGH as a label + one
 *     "not yet populated" warning (the clause is correct but inert until the
 *     deferred matcher runs).
 *   - NON-EMPTY catalog set → a slug whose `<idPrefix><slug>` id is not in the
 *     set is DROPPED + warned (kills hallucinations); known slugs become labels.
 * Labels emitted are `<labelPrefix><slug>` (e.g. `mb-feature-widget`).
 */
function resolveCatalogAxis(
  values: readonly string[],
  catalogIds: ReadonlySet<string>,
  idPrefix: string,
  labelPrefix: string,
  axisName: string,
  warnings: string[],
): string[] {
  const labels: string[] = [];
  let dropped = 0;
  const catalogEmpty = catalogIds.size === 0;
  for (const raw of values) {
    const s = slug(raw ?? "");
    if (s.length === 0) continue;
    if (catalogEmpty) {
      labels.push(`${labelPrefix}${s}`);
      continue;
    }
    if (catalogIds.has(`${idPrefix}${s}`)) {
      labels.push(`${labelPrefix}${s}`);
    } else {
      dropped++;
    }
  }
  if (catalogEmpty && labels.length > 0) {
    warnings.push(
      `${axisName} labels not yet populated — this clause matches nothing until the deferred matcher runs.`,
    );
  }
  if (dropped > 0) {
    warnings.push(`dropped ${dropped} unknown ${axisName} value(s) (not in catalog).`);
  }
  return labels;
}

/**
 * Build the JQL string from a structured filter + the legal vocabulary.
 *
 * Composition: `project in (...)` (when projects present) AND each non-empty
 * label axis (feature, then flow, then symptom — within-axis OR via
 * `labels in (...)`, across-axis AND) AND the status clause (last). Pure +
 * referentially transparent: same `(filter, vocab)` → identical `{jql, warnings}`.
 */
export function buildJqlFromFilter(filter: StructuredFilter, vocab: LabelVocab): JqlBuildResult {
  const warnings: string[] = [];

  // --- Symptom axis: HARD validation against the live taxonomy ---
  const symptomLabels: string[] = [];
  let droppedSymptoms = 0;
  for (const raw of filter.symptoms ?? []) {
    const s = slug(raw ?? "");
    if (s.length === 0) continue;
    if (vocab.symptoms.has(s)) {
      symptomLabels.push(`${NS_SYMPTOM}${s}`);
    } else {
      droppedSymptoms++;
    }
  }
  if (droppedSymptoms > 0) {
    warnings.push(`dropped ${droppedSymptoms} unknown symptom value(s) (not in taxonomy).`);
  }

  // --- Feature / flow axes: catalog-conditional (forward-compatible) ---
  const featureLabels = resolveCatalogAxis(
    filter.features ?? [],
    vocab.featureIds,
    "feature-",
    NS_FEATURE,
    "feature",
    warnings,
  );
  const flowLabels = resolveCatalogAxis(
    filter.flows ?? [],
    vocab.flowIds,
    "flow-",
    NS_FLOW,
    "flow",
    warnings,
  );

  // --- Project clause (prepended) — keys sanitised for injection-safety ---
  const projectKeys = [
    ...new Set(
      (filter.projects ?? [])
        .map((p) => (p ?? "").replace(/[^A-Za-z0-9_]/g, "").toUpperCase())
        .filter((p) => p.length > 0),
    ),
  ].sort();

  // --- Assemble: project AND feature AND flow AND symptom AND status ---
  const clauses: string[] = [];
  if (projectKeys.length > 0) {
    clauses.push(`project in (${projectKeys.join(",")})`);
  }
  if (featureLabels.length > 0) clauses.push(labelsInClause(featureLabels));
  if (flowLabels.length > 0) clauses.push(labelsInClause(flowLabels));
  if (symptomLabels.length > 0) clauses.push(labelsInClause(symptomLabels));

  const status =
    typeof filter.extraStatus === "string" && filter.extraStatus.trim().length > 0
      ? filter.extraStatus.trim()
      : DEFAULT_STATUS;
  clauses.push(status);

  return { jql: clauses.join(" AND "), warnings };
}
