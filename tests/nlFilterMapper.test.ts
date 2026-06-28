import {
  buildLlmFilterMapper,
  parseFilterJson,
  emptyFilter,
  MessagesCreate,
} from "../src/jira/nlFilterMapper";
import { LabelVocab } from "../src/jira/jqlFromFilter";
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
});
