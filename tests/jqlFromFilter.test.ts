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
});
