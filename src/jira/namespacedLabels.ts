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
 * PARENT (bucket) namespaces (#1387) — a coarse "family" label derived from a
 * child id via the full→lean map. ONE umbrella prefix `mb-bucket-` (so unstamp
 * peels every parent with one rule); the embedded axis word lets the writer
 * apply single-vs-multi semantics mirroring the children.
 */
export const NS_BUCKET_FEATURE = "mb-bucket-feature-";
export const NS_BUCKET_FLOW = "mb-bucket-flow-";

/**
 * GROWTH markers (#1387) — a PROVISIONAL (auto-created, unreviewed) child kept in
 * its OWN namespace so it can never be mistaken for a canonical `mb-feature-*` id
 * and is trivially peeled at graduation. `LABEL_AUTOCREATED` is a flat audit
 * marker so ONE JQL term surfaces every auto-labeled defect for human review.
 */
export const NS_PROV_FEATURE = "mb-prov-feature-";
export const LABEL_AUTOCREATED = "mb-autocreated";

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
  /**
   * Optional parent map (#1387): full catalog id (`feature-<slug>` / `flow-<slug>`)
   * → its lean BUCKET id (also `feature-<slug>` / `flow-<slug>`). Wired from the
   * gitignored `full-to-lean-map.json`. ABSENT → no parent labels are emitted
   * (backward-compatible: a catalog without `parentOf` yields child+symptom only).
   */
  parentOf?: ReadonlyMap<string, string>;
}

/** Minimal catalog shape (the gitignored `FeatureCatalog`) for set derivation. */
export interface CatalogIdSource {
  features: ReadonlyArray<{ id: string }>;
  flows: ReadonlyArray<{ id: string }>;
}

/**
 * Derive the injected membership sets from a (synthetic or real) catalog. The
 * optional `parentOf` map (#1387, full child id → lean bucket id) is threaded
 * through unchanged so the shell can wire the gitignored full→lean map.
 */
export function membershipFromCatalog(
  catalog: CatalogIdSource,
  parentOf?: ReadonlyMap<string, string>,
): LabelCatalog {
  return {
    featureIds: new Set(catalog.features.map((e) => e.id)),
    flowIds: new Set(catalog.flows.map((e) => e.id)),
    ...(parentOf ? { parentOf } : {}),
  };
}

/**
 * Pure helper (#1387): derive the PARENT bucket label for a child catalog id.
 * The lean id already carries its axis word (`feature-…` / `flow-…`), so the
 * parent label is simply `"mb-bucket-" + leanId`. A child with no map entry →
 * `undefined` (caller omits the parent — never throws).
 */
export function parentBucketLabel(
  childId: string,
  parentOf?: ReadonlyMap<string, string>,
): string | undefined {
  const leanId = parentOf?.get(childId);
  return leanId ? `mb-bucket-${leanId}` : undefined;
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
  /** PARENT bucket label for the feature child (#1387), if mapped. */
  featureBucket?: string;
  /** De-duped PARENT bucket labels for the flow children (#1387). */
  flowBuckets: string[];
  /**
   * TYPED additive growth labels (#1387, MED-1): a minted provisional child +
   * its bucket + the `mb-autocreated` marker. The writer reads this field
   * directly — a label present ONLY in `desired` would be computed but NEVER
   * written. Default `[]`.
   */
  provisionalAdds: string[];
  /** How many supplied feature/flow members were DROPPED as invalid (#1387). */
  droppedCount: number;
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
 * PARTIAL validation (#1387): on the feature/flow axes, a value that fails
 * `resolveCatalogId` is DROPPED (axis-only log), not fatal — the valid members
 * are kept. The loud `LabelValidationError` is thrown ONLY when something was
 * supplied but NOTHING valid remains (`supplied > 0 && valid === 0`) — the
 * all-invalid loud guard is NOT weakened. A symptom-only assignment (no feature,
 * empty flows: `supplied === 0`) never trips the feature/flow guard. The symptom
 * axis keeps its own independent throw.
 *
 * DUAL labels (#1387): each valid child also contributes a PARENT bucket label
 * derived via `catalog.parentOf`; a child with no map entry logs axis-only and
 * simply omits its parent. Child + parent + symptom all land in `desired`.
 */
export function buildDesiredLabels(
  assignment: LabelAssignment,
  catalog: LabelCatalog,
  symptoms: ReadonlySet<string> = new Set(DEFECT_CATEGORIES),
  log: (msg: string) => void = (m) => console.error(m),
): ValidatedLabels {
  let supplied = 0;
  let valid = 0;
  let droppedCount = 0;

  // FEATURE axis (single-value) — collect-then-decide (partial validation).
  let featureLabel: string | undefined;
  let featureBucket: string | undefined;
  if (assignment.feature !== undefined && assignment.feature !== "") {
    supplied++;
    const id = resolveCatalogId(assignment.feature, "feature", catalog.featureIds);
    if (id === undefined) {
      log("namespaced-label: dropped invalid feature (kept rest; axis only)");
      droppedCount++;
    } else {
      valid++;
      featureLabel = `mb-${id}`;
      featureBucket = parentBucketLabel(id, catalog.parentOf);
      if (featureBucket === undefined) {
        log("namespaced-label: child has no parent-bucket mapping (axis only)");
      }
    }
  }

  // FLOW axis (multi-value) — drop only the invalid members, keep the rest.
  const flowLabels: string[] = [];
  const flowBucketSet = new Set<string>();
  for (const flow of assignment.flows ?? []) {
    supplied++;
    const id = resolveCatalogId(flow, "flow", catalog.flowIds);
    if (id === undefined) {
      log("namespaced-label: dropped invalid flow (kept rest; axis only)");
      droppedCount++;
      continue;
    }
    valid++;
    flowLabels.push(`mb-${id}`);
    const bucket = parentBucketLabel(id, catalog.parentOf);
    if (bucket === undefined) {
      log("namespaced-label: child has no parent-bucket mapping (axis only)");
    } else {
      flowBucketSet.add(bucket);
    }
  }

  // ALL-INVALID loud guard (NOT weakened): something was supplied on the
  // feature/flow axes but nothing valid remained → fail loud + throw. The loud
  // line names ONLY the axis (PUBLIC repo); the error value stays a SUPPLIED
  // value, never an internal-name-derived string.
  if (supplied > 0 && valid === 0) {
    const featureSupplied = assignment.feature !== undefined && assignment.feature !== "";
    const axis: LabelKind = featureSupplied ? "feature" : "flow";
    log(`namespaced-label: REJECTED unknown ${axis} (validation failed BEFORE write)`);
    const value = featureSupplied
      ? (assignment.feature as string)
      : ((assignment.flows ?? [])[0] ?? "");
    throw new LabelValidationError(axis, value);
  }

  const symptomSlug = slug(assignment.symptom ?? "");
  if (!symptoms.has(symptomSlug)) {
    log("namespaced-label: REJECTED unknown symptom (validation failed BEFORE write)");
    throw new LabelValidationError("symptom", assignment.symptom);
  }
  const symptomLabel = `${NS_SYMPTOM}${symptomSlug}`;

  const flowBuckets = [...flowBucketSet];
  const desired = [
    ...(featureLabel ? [featureLabel] : []),
    ...flowLabels,
    ...(featureBucket ? [featureBucket] : []),
    ...flowBuckets,
    symptomLabel,
  ];
  return {
    feature: featureLabel,
    flows: flowLabels,
    symptom: symptomLabel,
    featureBucket,
    flowBuckets,
    provisionalAdds: [],
    droppedCount,
    desired,
  };
}

/**
 * Attach a MINTED provisional child to a validated label set (#1387, growth).
 * Pushes `mb-prov-feature-<slug>`, the parent bucket `mb-bucket-<parentLeanId>`,
 * and the `mb-autocreated` marker into BOTH `provisionalAdds` (so the writer
 * actually emits them — MED-1) AND `desired` (for JQL / diff parity). Pure.
 */
export function withProvisionalChild(
  base: ValidatedLabels,
  candidateSlug: string,
  parentLeanId: string,
): ValidatedLabels {
  const adds = [
    `${NS_PROV_FEATURE}${candidateSlug}`,
    `mb-bucket-${parentLeanId}`,
    LABEL_AUTOCREATED,
  ];
  const provisionalAdds = [...base.provisionalAdds];
  const desired = [...base.desired];
  for (const a of adds) {
    if (!provisionalAdds.includes(a)) provisionalAdds.push(a);
    if (!desired.includes(a)) desired.push(a);
  }
  return { ...base, provisionalAdds, desired };
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
  leanBuckets: readonly string[] = [],
): string {
  const labels = [
    ...catalog.features.map((e) => `mb-${e.id}`),
    ...catalog.flows.map((e) => `mb-${e.id}`),
    ...symptoms.map((s) => `${NS_SYMPTOM}${s}`),
    // PARENT bucket labels (#1387): one `mb-bucket-<leanId>` per distinct lean
    // id present in the full→lean map (the shell supplies the distinct list).
    ...leanBuckets.map((lean) => `mb-bucket-${lean}`),
  ];
  return labelsInClause(labels);
}
