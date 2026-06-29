import {
  buildLlmFilterMapper,
  parseFilterJson,
  emptyFilter,
  MessagesCreate,
} from "../src/jira/nlFilterMapper";
import { LabelVocab, buildJqlFromFilter } from "../src/jira/jqlFromFilter";
import { DEFECT_CATEGORIES } from "../src/triage/categorizeDefect";

/**
 * #1332 Stage C — LLM mapper contract. ZERO network: the message-creating call
 * is INJECTED (canned JSON), and the test-mode stub needs no client at all.
 * SYNTHETIC vocab ONLY (no real catalog vocabulary appears here).
 */

const VOCAB: LabelVocab = {
  symptoms: new Set(DEFECT_CATEGORIES),
  featureIds: new Set(["feature-widget"]),
  flowIds: new Set(["flow-onboarding"]),
};

/** A fake `messages.create` returning a fixed text block. */
function cannedCreate(text: string): MessagesCreate {
  return async () => ({ content: [{ type: "text", text }] });
}

describe("parseFilterJson", () => {
  it("parses a well-formed filter object", () => {
    const f = parseFilterJson('{"symptoms":["crash-error"],"features":["widget"],"flows":[],"projects":["DEMO"]}');
    expect(f.symptoms).toEqual(["crash-error"]);
    expect(f.features).toEqual(["widget"]);
    expect(f.projects).toEqual(["DEMO"]);
  });

  it("tolerates code-fenced / chatty JSON", () => {
    const f = parseFilterJson('Sure!\n```json\n{"symptoms":["performance"]}\n```');
    expect(f.symptoms).toEqual(["performance"]);
  });

  it("degrades malformed/empty input to an empty filter", () => {
    expect(parseFilterJson("not json at all")).toEqual(emptyFilter());
    expect(parseFilterJson("")).toEqual(emptyFilter());
    expect(parseFilterJson("{ broken")).toEqual(emptyFilter());
  });

  it("NEVER reads an extraStatus field from model output (operator-only)", () => {
    const f = parseFilterJson('{"symptoms":["crash-error"],"extraStatus":"status = Done"}') as unknown as Record<
      string,
      unknown
    >;
    expect(f.extraStatus).toBeUndefined();
  });
});

describe("buildLlmFilterMapper — injected client (zero network)", () => {
  it("maps a canned JSON response to a StructuredFilter", async () => {
    const mapper = buildLlmFilterMapper({
      createMessage: cannedCreate('{"symptoms":["crash-error"],"features":["widget"],"flows":[],"projects":[]}'),
    });
    const f = await mapper.map("show me checkout crashes", VOCAB);
    expect(f.symptoms).toEqual(["crash-error"]);
    expect(f.features).toEqual(["widget"]);
  });

  it("degrades a malformed response to an empty filter", async () => {
    const mapper = buildLlmFilterMapper({ createMessage: cannedCreate("¯\\_(ツ)_/¯") });
    expect(await mapper.map("anything", VOCAB)).toEqual(emptyFilter());
  });

  it("degrades a thrown client to an empty filter (never throws)", async () => {
    const mapper = buildLlmFilterMapper({
      createMessage: async () => {
        throw new Error("network down");
      },
    });
    expect(await mapper.map("anything", VOCAB)).toEqual(emptyFilter());
  });
});

describe("MONDAY_TEST_MODE stub — deterministic, no client", () => {
  const prev = process.env.MONDAY_TEST_MODE;
  beforeEach(() => {
    process.env.MONDAY_TEST_MODE = "1";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MONDAY_TEST_MODE;
    else process.env.MONDAY_TEST_MODE = prev;
  });

  it("returns a deterministic symptom filter without any client", async () => {
    // No createMessage injected — test mode must short-circuit before the client.
    const mapper = buildLlmFilterMapper();
    const f = await mapper.map("show me crashes", VOCAB);
    expect(f.symptoms).toEqual(["crash-error"]);
    // Same input → same output.
    const g = await mapper.map("show me crashes", VOCAB);
    expect(g).toEqual(f);
  });

  it("AC2 — distinct questions build DISTINCT JQL carrying the RIGHT clause (zero network)", async () => {
    const mapper = buildLlmFilterMapper();
    const priorityJql = buildJqlFromFilter(await mapper.map("high priority items", VOCAB), VOCAB).jql;
    const bugsJql = buildJqlFromFilter(await mapper.map("any open bugs", VOCAB), VOCAB).jql;

    // The priority question carries the hardcoded priority fragment...
    expect(priorityJql).toContain("priority in (High, Highest)");
    // ...the symptom question carries a symptom-labels clause...
    expect(bugsJql).toContain('labels in ("mb-symptom-crash-error")');
    // ...and the two are genuinely distinct (not the same degenerate query).
    expect(priorityJql).not.toBe(bugsJql);
  });

  it("AC3 — ≥4 example questions each build a DISTINCT, non-degenerate JQL with its axis fragment", async () => {
    const mapper = buildLlmFilterMapper();
    const cases: Array<{ q: string; fragment: string }> = [
      { q: "high priority items", fragment: "priority in (High, Highest)" },
      { q: "items from last release", fragment: "created >= -14d" },
      { q: "the app keeps crashing", fragment: 'labels in ("mb-symptom-crash-error")' },
      { q: "any open bugs this week", fragment: "created >= startOfWeek()" },
    ];
    const jqls = await Promise.all(
      cases.map(async ({ q }) => buildJqlFromFilter(await mapper.map(q, VOCAB), VOCAB).jql),
    );

    // (a) no two identical; (b) none is the bare status query; (c) each carries its fragment.
    expect(new Set(jqls).size).toBe(jqls.length);
    for (let i = 0; i < cases.length; i++) {
      expect(jqls[i]).not.toBe("statusCategory != Done");
      expect(jqls[i]).toContain(cases[i].fragment);
    }
    // The symptom+recency combo carries BOTH clauses.
    const combo = jqls[3];
    expect(combo).toContain('labels in ("mb-symptom-crash-error")');
    expect(combo).toContain("created >= startOfWeek()");
  });
});

describe("AC4 — empty/error floor fires ONLY on a genuine signal", () => {
  // The floor lives on the NON-test-mode path; make sure test mode is OFF here.
  const prev = process.env.MONDAY_TEST_MODE;
  beforeEach(() => {
    delete process.env.MONDAY_TEST_MODE;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MONDAY_TEST_MODE;
    else process.env.MONDAY_TEST_MODE = prev;
  });

  it("AC4a — a genuine-symptom question under the no-creds/error shape yields a NON-empty filter", async () => {
    // The model returns empty/non-JSON (the no-creds/error degrade shape).
    const mapper = buildLlmFilterMapper({ createMessage: cannedCreate("") });
    const f = await mapper.map("the app keeps crashing", VOCAB);
    expect(f).not.toEqual(emptyFilter());
    expect(f.symptoms).toEqual(["crash-error"]);
    // ...so the built JQL is NOT a bare status query.
    const { jql } = buildJqlFromFilter(f, VOCAB);
    expect(jql).not.toBe("statusCategory != Done");
    expect(jql).toContain('labels in ("mb-symptom-crash-error")');
  });

  it("AC4a — the floor also rescues a priority-only question on a thrown client", async () => {
    const mapper = buildLlmFilterMapper({
      createMessage: async () => {
        throw new Error("network down");
      },
    });
    const f = await mapper.map("only the high priority ones please", VOCAB);
    expect(f.priority).toBe("high");
    expect(buildJqlFromFilter(f, VOCAB).jql).toContain("priority in (High, Highest)");
  });

  it("AC4b — a fallback-only question ('anything') does NOT fire the floor (stays emptyFilter)", async () => {
    const malformed = buildLlmFilterMapper({ createMessage: cannedCreate("¯\\_(ツ)_/¯") });
    expect(await malformed.map("anything", VOCAB)).toEqual(emptyFilter());
    const thrown = buildLlmFilterMapper({
      createMessage: async () => {
        throw new Error("network down");
      },
    });
    expect(await thrown.map("anything", VOCAB)).toEqual(emptyFilter());
  });
});
