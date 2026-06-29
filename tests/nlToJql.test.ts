import { answerNlQuery } from "../src/jira/nlToJql";
import { NlFilterMapper } from "../src/jira/nlFilterMapper";
import { LabelVocab, StructuredFilter } from "../src/jira/jqlFromFilter";
import { JiraIssue, JqlSearchFetcher } from "../src/jira/sync";
import { DEFECT_CATEGORIES } from "../src/triage/categorizeDefect";

/**
 * #1332 Stage C — orchestrator composition with stub mapper + stub fetcher.
 * ZERO network. SYNTHETIC vocab + DEMO keys only.
 */

const VOCAB: LabelVocab = {
  symptoms: new Set(DEFECT_CATEGORIES),
  featureIds: new Set(["feature-widget"]),
  flowIds: new Set(["flow-onboarding"]),
};

function stubMapper(filter: StructuredFilter): NlFilterMapper {
  return { async map() { return filter; } };
}

function stubSearch(issues: JiraIssue[]): JqlSearchFetcher & { lastJql?: string } {
  const fetcher = {
    lastJql: undefined as string | undefined,
    async search(jql: string): Promise<JiraIssue[]> {
      fetcher.lastJql = jql;
      return issues;
    },
  };
  return fetcher;
}

const SYMPTOM_FILTER: StructuredFilter = {
  symptoms: ["crash-error"],
  features: [],
  flows: [],
  projects: [],
};

describe("answerNlQuery", () => {
  it("print-only (run absent): returns JQL + warnings, NO issues, never calls search", async () => {
    const search = stubSearch([{ key: "DEMO-1", summary: "boom", descriptionText: "", commentTexts: [] }]);
    const result = await answerNlQuery("show me crashes", {
      mapper: stubMapper(SYMPTOM_FILTER),
      vocab: VOCAB,
      search,
    });
    expect(result.jql).toContain('labels in ("mb-symptom-crash-error")');
    expect(result.issues).toBeUndefined();
    expect(search.lastJql).toBeUndefined();
  });

  it("--run: hands the built JQL to the fetcher and returns its issues", async () => {
    const issues: JiraIssue[] = [
      { key: "DEMO-1", summary: "boom", descriptionText: "", commentTexts: [] },
      { key: "DEMO-2", summary: "kaboom", descriptionText: "", commentTexts: [] },
    ];
    const search = stubSearch(issues);
    const result = await answerNlQuery("show me crashes", {
      mapper: stubMapper(SYMPTOM_FILTER),
      vocab: VOCAB,
      search,
      run: true,
    });
    expect(search.lastJql).toBe(result.jql);
    expect(result.issues).toEqual(issues);
  });
});

describe("answerNlQuery — default-project scoping (#1363)", () => {
  // SYNTHETIC keys only (PUBLIC repo): ABC = configured default, DEMO = question's.
  const EMPTY_FILTER: StructuredFilter = {
    symptoms: [],
    features: [],
    flows: [],
    projects: [],
  };
  const QUESTION_PROJECT_FILTER: StructuredFilter = {
    symptoms: [],
    features: [],
    flows: [],
    projects: ["DEMO"],
  };

  it("AC1/AC2 — empty filter + configured default scopes to the default, no whole-site scan", async () => {
    const result = await answerNlQuery("any open bugs?", {
      mapper: stubMapper(EMPTY_FILTER),
      vocab: VOCAB,
      defaultProjects: ["ABC"],
    });
    // AC1: the default fences the search.
    expect(result.jql).toContain("project in (ABC)");
    // AC2: it is NOT the bare whole-site scan.
    expect(result.jql).not.toBe("statusCategory != Done");
  });

  it("AC3 — a project NAMED in the question wins over the default", async () => {
    const result = await answerNlQuery("open bugs in DEMO", {
      mapper: stubMapper(QUESTION_PROJECT_FILTER),
      vocab: VOCAB,
      defaultProjects: ["ABC"],
    });
    expect(result.jql).toContain("project in (DEMO)");
    expect(result.jql).not.toContain("ABC");
  });

  it("AC4 — no default configured ⇒ behaviour unchanged (no project fence forced)", async () => {
    const result = await answerNlQuery("any open bugs?", {
      mapper: stubMapper(EMPTY_FILTER),
      vocab: VOCAB,
    });
    expect(result.jql).not.toContain("project in");
    expect(result.jql).toBe("statusCategory != Done");
  });

  it("does not mutate the mapper-returned filter object", async () => {
    const original: StructuredFilter = {
      symptoms: [],
      features: [],
      flows: [],
      projects: [],
    };
    await answerNlQuery("any open bugs?", {
      mapper: stubMapper(original),
      vocab: VOCAB,
      defaultProjects: ["ABC"],
    });
    expect(original.projects).toEqual([]);
  });
});
