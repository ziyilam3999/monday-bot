/**
 * Pure, I/O-free model for the bot's namespaced Jira labels (#1322).
 *
 * The bot is the SOLE writer of three label namespaces, all prefixed `mb-`
 * ("monday-bot's private sticker drawer"):
 *   - `mb-feature-<slug>` — exactly ONE per issue (which product area).
 *   - `mb-flow-<slug>`    — zero-or-more per issue (which user journeys).
 *   - `mb-symptom-<cat>`  — exactly ONE per issue (the deterministic symptom).
 *
 * Because the bot owns the namespaces, the usual "labels rot" failure mode is
 * recovered by a HARD validation gate: every value is canonicalised through the
 * ONE shared `slug()` and checked for membership in the catalog (feature/flow)
 * or the symptom taxonomy BEFORE any label string is constructed. An unknown
 * value is refused (fail-loud) — the writer is never reached, so zero network.
 *
 * No fs / network / creds here: this module is unit-tested with synthetic data.
 */
import { slug } from "../catalog/slug";
import { DEFECT_CATEGORIES } from "../triage/categorizeDefect";

/** Namespace prefixes — the bot's private drawer. */
export const NS_FEATURE = "mb-feature-";
export const NS_FLOW = "mb-flow-";
export const NS_SYMPTOM = "mb-symptom-";

/**
 * Per-issue assignment the backfill produces: a symptom (always, from the
 * deterministic categorizer) plus an optional feature and zero-or-more flows
 * (from the injected classifier seam). The raw string values are slugged +
 * validated here before becoming labels.
 */
export interface LabelAssignment {
  /** Optional product-area value (slugged + checked against the catalog). */
  feature?: string;
  /** Zero-or-more journey values (each slugged + checked against the catalog). */
  flows: string[];
  /** Symptom value (checked against the `DEFECT_CATEGORIES` taxonomy). */
  symptom: string;
}

/**
 * Membership sets the validator checks against. `featureIds` / `flowIds` carry
 * the catalog ENTRY ids (already `feature-<slug>` / `flow-<slug>`); they are
 * loaded by the shell from the gitignored catalog and injected (tests pass
 * synthetic sets). The symptom axis defaults to the in-repo taxonomy.
 */
export interface LabelCatalog {
  featureIds: ReadonlySet<string>;
  flowIds: ReadonlySet<string>;
}

/** Minimal catalog shape (the gitignored `FeatureCatalog`) for set derivation. */
export interface CatalogIdSource {
  features: ReadonlyArray<{ id: string }>;
  flows: ReadonlyArray<{ id: string }>;
}

/** Derive the injected membership sets from a (synthetic or real) catalog. */
export function membershipFromCatalog(catalog: CatalogIdSource): LabelCatalog {
  return {
    featureIds: new Set(catalog.features.map((e) => e.id)),
    flowIds: new Set(catalog.flows.map((e) => e.id)),
  };
}

/**
 * The validated, ready-to-write label set for one issue. `desired` is the FULL
 * set of bot labels this issue should carry (feature? + flows + symptom) — the
 * writer diffs it against the issue's CURRENT labels.
 */
export interface ValidatedLabels {
  /** Full `mb-feature-<slug>` label, if a feature was assigned. */
  feature?: string;
  /** Full `mb-flow-<slug>` labels. */
  flows: string[];
  /** Full `mb-symptom-<cat>` label. */
  symptom: string;
  /** Every desired bot label (the writer's diff target). */
  desired: string[];
}

/** Which axis a rejected value belonged to. */
export type LabelKind = "feature" | "flow" | "symptom";

/**
 * Raised when a value is NOT in the catalog / taxonomy. Carries the axis + value
 * for the caller; the persistent fail-loud LOG (see `buildDesiredLabels`) names
 * only the axis, never the value — internal product names must not leak to a
 * committed/structured log in a PUBLIC repo.
 */
export class LabelValidationError extends Error {
  constructor(
    public readonly kind: LabelKind,
    public readonly value: string,
  ) {
    super(`namespaced-label: rejected unknown ${kind} value (not in catalog/taxonomy)`);
    this.name = "LabelValidationError";
  }
}

/**
 * Idempotently, membership-AWARE, resolve a feature/flow value to its canonical
 * catalog id. The value may arrive EITHER as a bare slug (`widget`) OR as an
 * already kind-prefixed catalog id (`feature-widget`) — the matcher
 * (`featureFlowMatcher.ts`) returns the latter, legacy callers/tests pass the
 * former. Both MUST resolve to the SAME id, validated against the catalog set
 * exactly once.
 *
 * Rule: slug the value to `s`. If `s` is ALREADY a member of the catalog set,
 * that IS the canonical id (the value was a canonical id all along — e.g.
 * `feature-feature-flags` whose label legitimately starts with the kind word).
 * Otherwise treat it as bare and prefix it (`<kind>-<s>`). Return the chosen id
 * only if it is in the set; otherwise `undefined` (caller fails loud). This does
 * NOT weaken the guard: a value that is neither `s` nor `<kind>-<s>` in the set
 * yields `undefined` and is still rejected.
 */
function resolveCatalogId(
  value: string,
  kind: "feature" | "flow",
  ids: ReadonlySet<string>,
): string | undefined {
  const s = slug(value);
  const id = ids.has(s) ? s : `${kind}-${s}`;
  return ids.has(id) ? id : undefined;
}

/**
 * Canonicalise + VALIDATE an assignment, then construct the bot labels.
 *
 * Validation happens BEFORE any label is returned and BEFORE the writer is ever
 * called: an unknown feature/flow/symptom emits a fail-loud (axis-only) log line
 * and THROWS `LabelValidationError`. A valid assignment yields the full
 * `ValidatedLabels` (feature? + flows + symptom) plus the `desired` set.
 */
export function buildDesiredLabels(
  assignment: LabelAssignment,
  catalog: LabelCatalog,
  symptoms: ReadonlySet<string> = new Set(DEFECT_CATEGORIES),
  log: (msg: string) => void = (m) => console.error(m),
): ValidatedLabels {
  let featureLabel: string | undefined;
  if (assignment.feature !== undefined && assignment.feature !== "") {
    const id = resolveCatalogId(assignment.feature, "feature", catalog.featureIds);
    if (id === undefined) {
      log("namespaced-label: REJECTED unknown feature (validation failed BEFORE write)");
      throw new LabelValidationError("feature", assignment.feature);
    }
    featureLabel = `mb-${id}`;
  }

  const flowLabels: string[] = [];
  for (const flow of assignment.flows ?? []) {
    const id = resolveCatalogId(flow, "flow", catalog.flowIds);
    if (id === undefined) {
      log("namespaced-label: REJECTED unknown flow (validation failed BEFORE write)");
      throw new LabelValidationError("flow", flow);
    }
    flowLabels.push(`mb-${id}`);
  }

  const symptomSlug = slug(assignment.symptom ?? "");
  if (!symptoms.has(symptomSlug)) {
    log("namespaced-label: REJECTED unknown symptom (validation failed BEFORE write)");
    throw new LabelValidationError("symptom", assignment.symptom);
  }
  const symptomLabel = `${NS_SYMPTOM}${symptomSlug}`;

  const desired = [
    ...(featureLabel ? [featureLabel] : []),
    ...flowLabels,
    symptomLabel,
  ];
  return { feature: featureLabel, flows: flowLabels, symptom: symptomLabel, desired };
}

/**
 * Render a SORTED, DE-DUPED, double-quoted `labels in (...)` JQL clause from a
 * list of label strings. Jira label matching is EXACT — there is NO `mb-*`
 * wildcard — so an explicit enumerated list is the only way to match "these
 * labels". This is the ONE shared clause builder: both `buildBotLabelJql` and
 * the NL→JQL builder (`buildJqlFromFilter`) compose their `labels in (...)`
 * clauses through here so quoting/sort/dedupe never drift. Deterministic.
 */
export function labelsInClause(labels: readonly string[]): string {
  const sorted = [...new Set(labels)].sort();
  const quoted = sorted.map((l) => `"${l}"`).join(",");
  return `labels in (${quoted})`;
}

/**
 * Generate the ENUMERATED `labels in (...)` JQL for every bot label the catalog
 * can produce. Jira label matching is EXACT — there is NO `mb-*` wildcard — so
 * "only the bot's labels" must be an explicit, sorted, double-quoted list the
 * bot regenerates whenever the catalog grows. Deterministic string output.
 */
export function buildBotLabelJql(
  catalog: CatalogIdSource,
  symptoms: readonly string[] = DEFECT_CATEGORIES,
): string {
  const labels = [
    ...catalog.features.map((e) => `mb-${e.id}`),
    ...catalog.flows.map((e) => `mb-${e.id}`),
    ...symptoms.map((s) => `${NS_SYMPTOM}${s}`),
  ];
  return labelsInClause(labels);
}
