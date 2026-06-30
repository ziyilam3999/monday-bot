import { buildJqlFromFilter, LabelVocab, StructuredFilter } from "../src/jira/jqlFromFilter";
import { DEFECT_CATEGORIES } from "../src/triage/categorizeDefect";

/**
 * #1332 Stage C — exhaustive PURE-builder contract.
 *
 * SYNTHETIC vocab ONLY: the 8 live symptom slugs + invented feature/flow ids
 * (`feature-widget`, `flow-onboarding`) + DEMO/PROJ project keys. ZERO LLM, ZERO
 * I/O — the builder is referentially transparent.
 */

/** A populated synthetic catalog vocab (feature/flow ids landed). */
const VOCAB: LabelVocab = {
  symptoms: new Set(DEFECT_CATEGORIES),
  featureIds: new Set(["feature-widget"]),
  flowIds: new Set(["flow-onboarding"]),
};

/** An EMPTY-catalog vocab (feature/flow not yet populated — forward-compat). */
const VOCAB_EMPTY_CATALOG: LabelVocab = {
  symptoms: new Set(DEFECT_CATEGORIES),
  featureIds: new Set<string>(),
  flowIds: new Set<string>(),
};

function filter(over: Partial<StructuredFilter> = {}): StructuredFilter {
  return { symptoms: [], features: [], flows: [], projects: [], ...over };
}

describe("AC3 — symptom-only JQL is correct", () => {
  it("emits the symptom labels clause AND the default status, no warnings", () => {
    const { jql, warnings } = buildJqlFromFilter(filter({ symptoms: ["crash-error"] }), VOCAB);
    expect(jql).toContain('labels in ("mb-symptom-crash-error")');
    expect(jql).toContain("statusCategory != Done");
    expect(warnings).toEqual([]);
  });
});

describe("within-axis OR (multi-symptom)", () => {
  it("packs multiple symptoms into ONE sorted clause", () => {
    const { jql } = buildJqlFromFilter(
      filter({ symptoms: ["performance", "crash-error"] }),
      VOCAB,
    );
    // Sorted + single clause holding BOTH (within-axis OR).
    expect(jql).toContain('labels in ("mb-symptom-crash-error","mb-symptom-performance")');
  });
});

describe("AC4 — AND-across-axes / OR-within-axis", () => {
  it("feature + two symptoms = a feature clause AND a single two-symptom clause, joined by AND", () => {
    const { jql } = buildJqlFromFilter(
      filter({ features: ["widget"], symptoms: ["crash-error", "performance"] }),
      VOCAB,
    );
    expect(jql).toContain('labels in ("mb-feature-widget")');
    expect(jql).toContain('labels in ("mb-symptom-crash-error","mb-symptom-performance")');
    expect(jql).toContain(
      'labels in ("mb-feature-widget") AND labels in ("mb-symptom-crash-error","mb-symptom-performance")',
    );
  });
});

describe("project clause", () => {
  it("prepends a sorted project in (...) clause", () => {
    const { jql } = buildJqlFromFilter(
      filter({ symptoms: ["crash-error"], projects: ["PROJ", "DEMO"] }),
      VOCAB,
    );
    expect(jql).toContain("project in (DEMO,PROJ)");
    expect(jql.indexOf("project in (")).toBeLessThan(jql.indexOf("labels in ("));
  });
});

describe("status override (operator extraStatus)", () => {
  it("uses extraStatus verbatim instead of the default", () => {
    const { jql } = buildJqlFromFilter(
      filter({ symptoms: ["crash-error"], extraStatus: "status = Done" }),
      VOCAB,
    );
    expect(jql).toContain("status = Done");
    expect(jql).not.toContain("statusCategory != Done");
  });
});

describe("AC5 — forward-compat for unlanded feature/flow", () => {
  it("passes a requested feature through as a label AND warns when the catalog is empty", () => {
    const { jql, warnings } = buildJqlFromFilter(
      filter({ features: ["widget"], symptoms: ["crash-error"] }),
      VOCAB_EMPTY_CATALOG,
    );
    expect(jql).toContain('labels in ("mb-feature-widget")');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join(" ")).toMatch(/feature labels not yet populated/i);
  });

  it("does the same for flows", () => {
    const { jql, warnings } = buildJqlFromFilter(
      filter({ flows: ["onboarding"], symptoms: ["crash-error"] }),
      VOCAB_EMPTY_CATALOG,
    );
    expect(jql).toContain('labels in ("mb-flow-onboarding")');
    expect(warnings.join(" ")).toMatch(/flow labels not yet populated/i);
  });
});

describe("hallucinated values are dropped + warned (axis-named, never echoed)", () => {
  it("drops an unknown symptom and warns without echoing the raw value", () => {
    const { jql, warnings } = buildJqlFromFilter(
      filter({ symptoms: ["crash-error", "not-a-real-symptom"] }),
      VOCAB,
    );
    expect(jql).toContain('labels in ("mb-symptom-crash-error")');
    expect(jql).not.toContain("not-a-real-symptom");
    expect(warnings.join(" ")).toMatch(/unknown symptom/i);
    expect(warnings.join(" ")).not.toContain("not-a-real-symptom");
  });

  it("drops an unknown feature when the catalog is NON-empty", () => {
    const { jql, warnings } = buildJqlFromFilter(
      filter({ features: ["widget", "ghost-feature"], symptoms: ["crash-error"] }),
      VOCAB,
    );
    expect(jql).toContain('labels in ("mb-feature-widget")');
    expect(jql).not.toContain("ghost-feature");
    expect(warnings.join(" ")).toMatch(/unknown feature/i);
  });
});

describe("slug injection-safety", () => {
  it("canonicalises weird characters to hyphens before quoting", () => {
    const { jql } = buildJqlFromFilter(
      filter({ symptoms: ['crash-error") OR labels in ("evil'] }),
      // Allow the slugged form into the synthetic taxonomy so we can see the output.
      { ...VOCAB, symptoms: new Set([...DEFECT_CATEGORIES, "crash-error-or-labels-in-evil"]) },
    );
    expect(jql).toContain('labels in ("mb-symptom-crash-error-or-labels-in-evil")');
    // No raw quote/paren injection survived.
    expect(jql).not.toContain('") OR labels in ("evil');
  });
});

describe("AC6 — deterministic output", () => {
  it("returns byte-identical jql + warnings on repeated calls", () => {
    const f = filter({
      features: ["widget"],
      flows: ["onboarding"],
      symptoms: ["performance", "crash-error"],
      projects: ["DEMO"],
    });
    const a = buildJqlFromFilter(f, VOCAB);
    const b = buildJqlFromFilter(f, VOCAB);
    expect(a.jql).toBe(b.jql);
    expect(a.warnings).toEqual(b.warnings);
  });
});

describe("empty filter degrades to status-only", () => {
  it("yields just the default status clause when nothing is requested", () => {
    const { jql, warnings } = buildJqlFromFilter(filter(), VOCAB);
    expect(jql).toBe("statusCategory != Done");
    expect(warnings).toEqual([]);
  });

  it("a fixture literal that OMITS priority/recency still compiles + builds status-only", () => {
    // `filter()` deliberately omits the optional priority/recency keys (F2).
    const { jql } = buildJqlFromFilter(filter({ symptoms: ["crash-error"] }), VOCAB);
    expect(jql).toContain('labels in ("mb-symptom-crash-error")');
    expect(jql).toContain("statusCategory != Done");
    expect(jql).not.toMatch(/priority/);
    expect(jql).not.toMatch(/created >=/);
  });
});

describe("#1364 — priority / recency closed-enum axes", () => {
  it("AC1 — two filters differing only by a NEW axis build DISTINCT JQL carrying the right fragment", () => {
    const priorityJql = buildJqlFromFilter(filter({ priority: "high" }), VOCAB).jql;
    const recencyJql = buildJqlFromFilter(filter({ recency: "this-week" }), VOCAB).jql;

    expect(priorityJql).toContain("priority in (High, Highest)");
    expect(recencyJql).toContain("created >= startOfWeek()");
    expect(priorityJql).not.toBe(recencyJql);
    // Neither is the bare status query.
    expect(priorityJql).not.toBe("statusCategory != Done");
    expect(recencyJql).not.toBe("statusCategory != Done");
  });

  it("each known recency token emits its own audited date fragment", () => {
    expect(buildJqlFromFilter(filter({ recency: "last-release" }), VOCAB).jql).toContain(
      "created >= -14d",
    );
    expect(buildJqlFromFilter(filter({ recency: "latest" }), VOCAB).jql).toContain(
      "created >= -7d",
    );
  });

  it("AC5 — an unknown/hostile token is DROPPED (no clause, no raw echo) + axis-named warn", () => {
    const hostile = '") OR labels in ("evil';
    const { jql, warnings } = buildJqlFromFilter(filter({ priority: hostile }), VOCAB);
    // No priority clause emitted; the hostile string never reaches the JQL.
    expect(jql).toBe("statusCategory != Done");
    expect(jql).not.toContain("evil");
    expect(jql).not.toContain("priority");
    // Axis-named warning that echoes NO raw value.
    expect(warnings.join(" ")).toMatch(/unknown priority/i);
    expect(warnings.join(" ")).not.toContain("evil");
  });

  it("drops a hostile recency token the same way (closed-enum, never char-stripped)", () => {
    const { jql, warnings } = buildJqlFromFilter(
      filter({ recency: "startOfWeek()); DROP TABLE" }),
      VOCAB,
    );
    expect(jql).toBe("statusCategory != Done");
    expect(jql).not.toContain("DROP TABLE");
    expect(warnings.join(" ")).toMatch(/unknown recency/i);
  });
});

/**
 * #1392 (Rule A) cross-axis same-stem union + #1385 (Rule B) full↔lean vocab.
 *
 * SYNTHETIC vocab ONLY. `VOCAB_UNION` holds feature/flow CHILDREN that can collide
 * by stem (`onboarding`, `checkout`) plus a flow CHILD `flow-platform` and a
 * feature BUCKET `feature-platform` so the bucket-vs-same-slug-child composition
 * (AC4b) is exercised. `VOCAB_FAMILIES` carries platform on BOTH bucket axes only.
 */
const VOCAB_UNION: LabelVocab = {
  symptoms: new Set(DEFECT_CATEGORIES),
  featureIds: new Set(["feature-widget", "feature-onboarding", "feature-checkout"]),
  flowIds: new Set(["flow-onboarding", "flow-checkout", "flow-platform"]),
  featureBucketIds: new Set(["feature-platform"]),
  flowBucketIds: new Set<string>(),
};

const VOCAB_FAMILIES: LabelVocab = {
  symptoms: new Set(DEFECT_CATEGORIES),
  featureIds: new Set(["feature-widget"]),
  flowIds: new Set(["flow-onboarding"]),
  featureBucketIds: new Set(["feature-platform"]),
  flowBucketIds: new Set(["flow-platform"]),
};

describe("#1392 Rule A — same-stem CHILD cross-axis union", () => {
  it("AC2 — feature+flow children sharing a stem merge into ONE OR-clause, not two AND clauses", () => {
    const { jql } = buildJqlFromFilter(
      filter({ features: ["onboarding"], flows: ["onboarding"] }),
      VOCAB_UNION,
    );
    // ONE merged union clause (recall), sorted feature-before-flow.
    expect(jql).toContain('labels in ("mb-feature-onboarding","mb-flow-onboarding")');
    // NOT the legacy two-AND intersection form.
    expect(jql).not.toContain(
      'labels in ("mb-feature-onboarding") AND labels in ("mb-flow-onboarding")',
    );
    expect(jql).toContain("statusCategory != Done");
  });

  it("AC5 — crossAxisUnion:false reverts to the legacy two-AND intersection (kill-switch)", () => {
    const { jql } = buildJqlFromFilter(
      filter({ features: ["onboarding"], flows: ["onboarding"] }),
      VOCAB_UNION,
      { crossAxisUnion: false },
    );
    expect(jql).toContain(
      'labels in ("mb-feature-onboarding") AND labels in ("mb-flow-onboarding")',
    );
    expect(jql).not.toContain('labels in ("mb-feature-onboarding","mb-flow-onboarding")');
  });

  it("symptom is NEVER merged — feature child + symptom stays a feature clause AND a symptom clause", () => {
    const { jql } = buildJqlFromFilter(
      filter({ features: ["widget"], symptoms: ["crash-error"] }),
      VOCAB_UNION,
    );
    expect(jql).toBe(
      'labels in ("mb-feature-widget") AND labels in ("mb-symptom-crash-error") AND statusCategory != Done',
    );
  });

  it("AC3 — TWO DISTINCT areas (different stems) STILL AND (genuine intersection preserved)", () => {
    const { jql } = buildJqlFromFilter(
      filter({ features: ["onboarding"], flows: ["checkout"] }),
      VOCAB_UNION,
    );
    expect(jql).toBe(
      'labels in ("mb-feature-onboarding") AND labels in ("mb-flow-checkout") AND statusCategory != Done',
    );
  });

  it("union + symptom together — area recall (one union clause) AND symptom precision", () => {
    const { jql } = buildJqlFromFilter(
      filter({ features: ["onboarding"], flows: ["onboarding"], symptoms: ["crash-error"] }),
      VOCAB_UNION,
    );
    expect(jql).toBe(
      'labels in ("mb-feature-onboarding","mb-flow-onboarding") AND labels in ("mb-symptom-crash-error") AND statusCategory != Done',
    );
  });

  it("two distinct collisions ⇒ TWO union clauses ANDed, sorted by stem (checkout before onboarding)", () => {
    const { jql } = buildJqlFromFilter(
      filter({ features: ["onboarding", "checkout"], flows: ["onboarding", "checkout"] }),
      VOCAB_UNION,
    );
    expect(jql).toBe(
      'labels in ("mb-feature-checkout","mb-flow-checkout") AND labels in ("mb-feature-onboarding","mb-flow-onboarding") AND statusCategory != Done',
    );
  });
});

describe("#1385 Rule B — full child OR lean bucket vocabulary", () => {
  it("AC4 — a feature-axis lean-bucket slug resolves to a mb-bucket-feature-* family clause", () => {
    const { jql } = buildJqlFromFilter(filter({ features: ["platform"] }), VOCAB_FAMILIES);
    expect(jql).toBe(
      'labels in ("mb-bucket-feature-platform") AND statusCategory != Done',
    );
  });

  it("AC4 — a flow-axis lean-bucket slug resolves to a mb-bucket-flow-* family clause", () => {
    const { jql } = buildJqlFromFilter(filter({ flows: ["platform"] }), VOCAB_FAMILIES);
    expect(jql).toBe('labels in ("mb-bucket-flow-platform") AND statusCategory != Done');
  });

  it("precedence — a full CHILD slug still resolves to mb-feature-* even when also a bucket id", () => {
    const vocab: LabelVocab = {
      symptoms: new Set(DEFECT_CATEGORIES),
      featureIds: new Set(["feature-platform"]),
      flowIds: new Set<string>(),
      featureBucketIds: new Set(["feature-platform"]),
      flowBucketIds: new Set<string>(),
    };
    const { jql } = buildJqlFromFilter(filter({ features: ["platform"] }), vocab);
    expect(jql).toContain('labels in ("mb-feature-platform")');
    expect(jql).not.toContain("mb-bucket-feature-platform");
  });

  it("NEG — a slug in NEITHER child nor bucket set (catalog populated) is dropped + axis-named warned, never echoed", () => {
    const { jql, warnings } = buildJqlFromFilter(
      filter({ features: ["ghostarea"] }),
      VOCAB_FAMILIES,
    );
    expect(jql).toBe("statusCategory != Done");
    expect(jql).not.toContain("ghostarea");
    expect(warnings.join(" ")).toMatch(/unknown feature/i);
    expect(warnings.join(" ")).not.toContain("ghostarea");
  });

  it("populated bucket set does NOT suppress the child-empty passthrough warning (gate keys off CHILD set)", () => {
    const vocab: LabelVocab = {
      symptoms: new Set(DEFECT_CATEGORIES),
      featureIds: new Set<string>(), // CHILD set empty → forward-compat passthrough
      flowIds: new Set<string>(),
      featureBucketIds: new Set(["feature-platform"]),
      flowBucketIds: new Set<string>(),
    };
    const { jql, warnings } = buildJqlFromFilter(filter({ features: ["widget"] }), vocab);
    expect(jql).toContain('labels in ("mb-feature-widget")');
    expect(warnings.join(" ")).toMatch(/feature labels not yet populated/i);
  });
});

describe("#1392/#1385 composition — buckets NEVER enter a union (AC4b, the resolved gap)", () => {
  it("AC4b — feature BUCKET + flow CHILD with the same residual slug do NOT merge (exact two-AND form)", () => {
    // featureBucketIds has feature-platform; flowIds (CHILD) has flow-platform.
    const first = buildJqlFromFilter(
      filter({ features: ["platform"], flows: ["platform"] }),
      VOCAB_UNION,
    );
    expect(first.jql).toBe(
      'labels in ("mb-bucket-feature-platform") AND labels in ("mb-flow-platform") AND statusCategory != Done',
    );
    // The merge substring MUST be ABSENT — a four-namespace stripper would emit it.
    expect(first.jql).not.toContain('mb-bucket-feature-platform","mb-flow-platform');
    // Determinism — a second call is byte-identical.
    const second = buildJqlFromFilter(
      filter({ features: ["platform"], flows: ["platform"] }),
      VOCAB_UNION,
    );
    expect(second.jql).toBe(first.jql);
    expect(second.warnings).toEqual(first.warnings);
  });

  it("a bucket on one axis + a DIFFERENT-stem child union on the other still compose (bucket never absorbed)", () => {
    // feature platform → bucket; feature/flow checkout → child union; buckets stay put.
    const { jql } = buildJqlFromFilter(
      filter({ features: ["platform", "checkout"], flows: ["checkout"] }),
      VOCAB_UNION,
    );
    expect(jql).toBe(
      'labels in ("mb-bucket-feature-platform") AND labels in ("mb-feature-checkout","mb-flow-checkout") AND statusCategory != Done',
    );
  });

  it("determinism — a union build is byte-identical across repeated calls", () => {
    const f = filter({
      features: ["onboarding", "checkout"],
      flows: ["onboarding", "checkout"],
      symptoms: ["crash-error"],
      projects: ["DEMO"],
    });
    const a = buildJqlFromFilter(f, VOCAB_UNION);
    const b = buildJqlFromFilter(f, VOCAB_UNION);
    expect(a.jql).toBe(b.jql);
    expect(a.warnings).toEqual(b.warnings);
  });
});
