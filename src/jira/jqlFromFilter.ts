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
import {
  labelsInClause,
  NS_BUCKET_FEATURE,
  NS_BUCKET_FLOW,
  NS_FEATURE,
  NS_FLOW,
  NS_SYMPTOM,
} from "./namespacedLabels";

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
  /**
   * OPTIONAL single-value priority axis — ONE closed token (e.g. `high`).
   * Resolved against a HARDCODED token→fragment table; an unknown token is
   * DROPPED + warned (never reaches the JQL). Omitted = no priority clause.
   */
  priority?: string;
  /**
   * OPTIONAL single-value recency/time-window axis — ONE closed token (e.g.
   * `this-week`). Resolved against a HARDCODED token→fragment table; an unknown
   * token is DROPPED + warned. Omitted = no recency clause.
   */
  recency?: string;
  /** OPERATOR-ONLY raw status clause override. Default = `statusCategory != Done`. */
  extraStatus?: string;
}

/**
 * HARDCODED, audited closed-enum token→JQL-fragment tables for the two
 * single-value axes. A KNOWN token emits its pre-written fragment verbatim; an
 * unknown/hostile token is DROPPED + axis-named-warned (see `resolveSingleAxis`).
 * The closed table IS the injection-safety mechanism: NO caller string ever
 * reaches the JQL, so these axes deliberately BYPASS the project-key char-strip
 * and `slug()` (which would mangle a valid date expression like `-14d` /
 * `startOfWeek()`). Lookup is via `Map` (not a plain object) so hostile keys
 * like `__proto__` cannot resolve to a prototype member.
 */
const PRIORITY_FRAGMENTS: ReadonlyMap<string, string> = new Map([
  ["high", "priority in (High, Highest)"],
  ["critical", "priority = Highest"],
  ["urgent", "priority = Highest"],
]);

const RECENCY_FRAGMENTS: ReadonlyMap<string, string> = new Map([
  ["this-week", "created >= startOfWeek()"],
  ["last-release", "created >= -14d"],
  ["latest", "created >= -7d"],
]);

/**
 * Resolve a single-value closed-enum axis to its audited JQL fragment.
 *   - axis UNSET (undefined/empty) → `null`, NO warning (no clause emitted).
 *   - KNOWN token → the table's audited fragment.
 *   - unknown/hostile token → `null` + ONE axis-named warning that echoes NO
 *     raw value (mirrors the symptom/catalog drop discipline; PUBLIC repo).
 * The raw value is used ONLY as a lookup key — it never reaches the output.
 */
function resolveSingleAxis(
  raw: string | undefined,
  table: ReadonlyMap<string, string>,
  axisName: string,
  warnings: string[],
): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (key.length === 0) return null;
  const fragment = table.get(key);
  if (fragment === undefined) {
    warnings.push(`dropped unknown ${axisName} value (not in the allowed set).`);
    return null;
  }
  return fragment;
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
  /**
   * OPTIONAL lean feature BUCKET ids (`feature-<slug>`, #1385) — the distinct
   * family ids the full→lean map points to. When present, a feature-axis slug
   * that misses the child set but hits a bucket id resolves to an
   * `mb-bucket-feature-<slug>` family clause. ABSENT/empty → no buckets offered
   * or accepted (behaviour identical to pre-#1385).
   */
  featureBucketIds?: ReadonlySet<string>;
  /** OPTIONAL lean flow BUCKET ids (`flow-<slug>`, #1385). Same semantics. */
  flowBucketIds?: ReadonlySet<string>;
}

/** The builder's deterministic output. */
export interface JqlBuildResult {
  jql: string;
  warnings: string[];
}

/** Default open-defects status clause (mirrors `buildOpenDefectsJql`). */
const DEFAULT_STATUS = "statusCategory != Done";

/**
 * Resolve a feature/flow axis against the catalog (Rule B, #1385). Per slug,
 * STRICT precedence — child → bucket → child-empty passthrough → drop:
 *   1. `<idPrefix><slug>` ∈ CHILD set → child label `<labelPrefix><slug>`
 *      (today's behaviour; precise area query).
 *   2. else `<idPrefix><slug>` ∈ BUCKET set → family label
 *      `<bucketLabelPrefix><slug>` (the broad family query #1385 accepts).
 *   3. else CHILD set EMPTY → passthrough `<labelPrefix><slug>` + one "not yet
 *      populated" warning (forward-compat — the gate keys off the CHILD set
 *      ONLY, evaluated AFTER the bucket check, so a populated bucket set never
 *      suppresses the warning).
 *   4. else (child set non-empty, no match on either) → DROP + axis-named warn.
 * Labels emitted are `<labelPrefix><slug>` (e.g. `mb-feature-widget`) or
 * `<bucketLabelPrefix><slug>` (e.g. `mb-bucket-feature-platform`).
 */
function resolveCatalogAxis(
  values: readonly string[],
  catalogIds: ReadonlySet<string>,
  idPrefix: string,
  labelPrefix: string,
  axisName: string,
  warnings: string[],
  bucketIds: ReadonlySet<string> = new Set<string>(),
  bucketLabelPrefix = "",
): string[] {
  const labels: string[] = [];
  let dropped = 0;
  let passthrough = 0;
  const catalogEmpty = catalogIds.size === 0;
  for (const raw of values) {
    const s = slug(raw ?? "");
    if (s.length === 0) continue;
    if (catalogIds.has(`${idPrefix}${s}`)) {
      labels.push(`${labelPrefix}${s}`); // 1. child (most precise)
    } else if (bucketIds.has(`${idPrefix}${s}`)) {
      labels.push(`${bucketLabelPrefix}${s}`); // 2. lean family bucket
    } else if (catalogEmpty) {
      labels.push(`${labelPrefix}${s}`); // 3. forward-compat passthrough (child set empty)
      passthrough++;
    } else {
      dropped++; // 4. unknown on a populated child set → drop
    }
  }
  if (passthrough > 0) {
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
 * referentially transparent: same `(filter, vocab, opts)` → identical
 * `{jql, warnings}`.
 *
 * Rule A — same-concept cross-axis union (#1392, gated by `opts.crossAxisUnion`,
 * default ON): when ONE named area is double-mapped as a feature CHILD AND a flow
 * CHILD sharing a byte-identical namespace-stripped stem, the two child labels
 * merge into ONE `labels in ("mb-feature-<stem>","mb-flow-<stem>")` OR-clause
 * (recall) instead of being ANDed (silent intersection). Union candidacy is
 * pinned to the two CHILD namespaces (`mb-feature-`/`mb-flow-`) — bucket/family
 * labels (`mb-bucket-*`) are NEVER union candidates and ride inside their per-axis
 * clause. Distinct stems still AND; the symptom axis is never merged.
 */
export function buildJqlFromFilter(
  filter: StructuredFilter,
  vocab: LabelVocab,
  opts?: { crossAxisUnion?: boolean },
): JqlBuildResult {
  const warnings: string[] = [];
  const crossAxisUnion = opts?.crossAxisUnion ?? true;

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

  // --- Feature / flow axes: catalog-conditional (forward-compatible) + lean
  // bucket resolution (Rule B, #1385) ---
  const featureLabels = resolveCatalogAxis(
    filter.features ?? [],
    vocab.featureIds,
    "feature-",
    NS_FEATURE,
    "feature",
    warnings,
    vocab.featureBucketIds ?? new Set<string>(),
    NS_BUCKET_FEATURE,
  );
  const flowLabels = resolveCatalogAxis(
    filter.flows ?? [],
    vocab.flowIds,
    "flow-",
    NS_FLOW,
    "flow",
    warnings,
    vocab.flowBucketIds ?? new Set<string>(),
    NS_BUCKET_FLOW,
  );

  // --- Rule A — same-stem CHILD cross-axis union (#1392) ---
  // Candidate iff the label begins with a CHILD namespace (`mb-feature-`/
  // `mb-flow-`); this structurally EXCLUDES `mb-bucket-*` (which begins with
  // `mb-bucket-`). The stem strips ONLY the matched child prefix. A stem that
  // appears as a child candidate on BOTH axes merges into one OR-clause.
  let featureClauseLabels = featureLabels;
  let flowClauseLabels = flowLabels;
  const unionClauses: string[] = [];
  if (crossAxisUnion) {
    const featureStems = new Map<string, string>(); // stem → child label
    for (const l of featureLabels) {
      if (l.startsWith(NS_FEATURE)) featureStems.set(l.slice(NS_FEATURE.length), l);
    }
    const flowStems = new Map<string, string>();
    for (const l of flowLabels) {
      if (l.startsWith(NS_FLOW)) flowStems.set(l.slice(NS_FLOW.length), l);
    }
    const collidingStems = [...featureStems.keys()].filter((s) => flowStems.has(s)).sort();
    if (collidingStems.length > 0) {
      const colliding = new Set(collidingStems);
      // Pull the colliding CHILD labels out of their per-axis clauses; buckets +
      // non-colliding children stay put.
      featureClauseLabels = featureLabels.filter(
        (l) => !(l.startsWith(NS_FEATURE) && colliding.has(l.slice(NS_FEATURE.length))),
      );
      flowClauseLabels = flowLabels.filter(
        (l) => !(l.startsWith(NS_FLOW) && colliding.has(l.slice(NS_FLOW.length))),
      );
      // One merged OR-clause per colliding stem, emitted sorted-by-stem.
      for (const stem of collidingStems) {
        unionClauses.push(labelsInClause([featureStems.get(stem)!, flowStems.get(stem)!]));
      }
    }
  }

  // --- Project clause (prepended) — keys sanitised for injection-safety ---
  const projectKeys = [
    ...new Set(
      (filter.projects ?? [])
        .map((p) => (p ?? "").replace(/[^A-Za-z0-9_]/g, "").toUpperCase())
        .filter((p) => p.length > 0),
    ),
  ].sort();

  // --- Priority / recency single-value axes (closed-enum, never char-stripped) ---
  const priorityFragment = resolveSingleAxis(filter.priority, PRIORITY_FRAGMENTS, "priority", warnings);
  const recencyFragment = resolveSingleAxis(filter.recency, RECENCY_FRAGMENTS, "recency", warnings);

  // --- Assemble (deterministic order): project → feature clause (non-colliding
  // children + all feature buckets) → flow clause (non-colliding children + all
  // flow buckets) → per-stem child-union clauses (sorted by stem) → symptom →
  // priority → recency → status ---
  const clauses: string[] = [];
  if (projectKeys.length > 0) {
    clauses.push(`project in (${projectKeys.join(",")})`);
  }
  if (featureClauseLabels.length > 0) clauses.push(labelsInClause(featureClauseLabels));
  if (flowClauseLabels.length > 0) clauses.push(labelsInClause(flowClauseLabels));
  for (const c of unionClauses) clauses.push(c);
  if (symptomLabels.length > 0) clauses.push(labelsInClause(symptomLabels));
  if (priorityFragment !== null) clauses.push(priorityFragment);
  if (recencyFragment !== null) clauses.push(recencyFragment);

  const status =
    typeof filter.extraStatus === "string" && filter.extraStatus.trim().length > 0
      ? filter.extraStatus.trim()
      : DEFAULT_STATUS;
  clauses.push(status);

  return { jql: clauses.join(" AND "), warnings };
}
