/**
 * Unit tests for the label-aware `/ask` augment (#1386) — bridges the doc Q&A
 * path to the SAME tagged-Jira-defect resolver `/jql` uses, additively.
 *
 * ZERO network: the `mapper` + `search` seams are injected and `MONDAY_TEST_MODE=1`
 * is set so even the fallback mapper is deterministic. SYNTHETIC fixtures only.
 *
 * NOTE ON SYNTHETIC HOSTS: these tests use `https://demo.example.com` (NOT the
 * Atlassian-branded sandbox host) to avoid the AC9 privacy grep — same convention
 * as `answerJql.test.ts`. Do NOT "fix" this back to the Atlassian-host form.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildAskJiraAugment,
  parseAskDefectsMax,
  resolveCatalogMatches,
} from "../src/jira/askAreaAugment";
import { NlFilterMapper } from "../src/jira/nlFilterMapper";
import { LabelVocab, StructuredFilter } from "../src/jira/jqlFromFilter";
import { buildVocab } from "../src/jira/labelVocab";
import { JiraIssue, JqlSearchFetcher } from "../src/jira/sync";

const SYNTHETIC_CREDS = {
  CONFLUENCE_URL: "https://demo.example.com",
  CONFLUENCE_EMAIL: "qa@example.com",
  CONFLUENCE_API_TOKEN: "synthetic-token",
} as unknown as NodeJS.ProcessEnv;

/** A synthetic single-feature catalog (`feature-widget`). */
const WIDGET_CATALOG = { features: [{ id: "feature-widget" }], flows: [] };

/** Write a synthetic catalog JSON to a fresh temp path and return it. */
function writeCatalog(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-augment-"));
  const p = path.join(dir, "feature-catalog.json");
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

/** A fake mapper returning a fixed StructuredFilter for ANY question. */
function fakeMapper(filter: Partial<StructuredFilter>): NlFilterMapper {
  return {
    map: jest.fn(
      async (): Promise<StructuredFilter> => ({
        symptoms: [],
        features: [],
        flows: [],
        projects: [],
        ...filter,
      }),
    ),
  };
}

function fakeSearch(issues: JiraIssue[]): JqlSearchFetcher & { search: jest.Mock } {
  return { search: jest.fn(async (_jql: string) => issues) };
}

const DEMO_ISSUE: JiraIssue = {
  key: "DEMO-1",
  summary: "synthetic crash",
  descriptionText: "",
  commentTexts: [],
};

describe("askAreaAugment (#1386) — buildAskJiraAugment", () => {
  let savedTestMode: string | undefined;

  beforeEach(() => {
    savedTestMode = process.env.MONDAY_TEST_MODE;
    process.env.MONDAY_TEST_MODE = "1";
  });

  afterEach(() => {
    if (savedTestMode === undefined) delete process.env.MONDAY_TEST_MODE;
    else process.env.MONDAY_TEST_MODE = savedTestMode;
    jest.restoreAllMocks();
  });

  it("detection true-positive: named known area + tagged defects ⇒ {jql, issues}, search once, no network", async () => {
    const mapper = fakeMapper({ features: ["widget"] });
    const search = fakeSearch([DEMO_ISSUE]);
    const fetchSpy = jest.spyOn(globalThis, "fetch");

    const augment = buildAskJiraAugment({
      env: SYNTHETIC_CREDS,
      mapper,
      search,
      catalogPath: writeCatalog(WIDGET_CATALOG),
    });
    const result = await augment("how do I use the widget area?");

    expect(result).not.toBeNull();
    expect(typeof result!.jql).toBe("string");
    expect(result!.jql.length).toBeGreaterThan(0);
    expect(result!.issues).toEqual([DEMO_ISSUE]);
    expect(search.search).toHaveBeenCalledTimes(1);
    expect(search.search).toHaveBeenCalledWith(result!.jql);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("true-negative (symptom-only): no area named ⇒ null, search NOT called", async () => {
    const mapper = fakeMapper({ symptoms: ["crash-error"] });
    const search = fakeSearch([DEMO_ISSUE]);

    const augment = buildAskJiraAugment({
      env: SYNTHETIC_CREDS,
      mapper,
      search,
      catalogPath: writeCatalog(WIDGET_CATALOG),
    });
    // Question passes the lexical pre-gate (contains "widget") so the mapper IS
    // consulted; the precision bar then drops the symptom-only filter.
    const result = await augment("the widget keeps crashing");

    expect(result).toBeNull();
    expect(search.search).not.toHaveBeenCalled();
  });

  it("unknown-area drop (populated catalog): mapped area not a catalog member ⇒ null, search NOT called", async () => {
    const mapper = fakeMapper({ features: ["not-in-catalog"] });
    const search = fakeSearch([DEMO_ISSUE]);

    const augment = buildAskJiraAugment({
      env: SYNTHETIC_CREDS,
      mapper,
      search,
      catalogPath: writeCatalog(WIDGET_CATALOG),
    });
    const result = await augment("question about the widget");

    expect(result).toBeNull();
    expect(search.search).not.toHaveBeenCalled();
  });

  it("empty-catalog short-circuit: empty catalog ⇒ null, mapper NOT called, search NOT called", async () => {
    const mapper = fakeMapper({ features: ["widget"] });
    const search = fakeSearch([DEMO_ISSUE]);

    const augment = buildAskJiraAugment({
      env: SYNTHETIC_CREDS,
      mapper,
      search,
      catalogPath: writeCatalog({ features: [], flows: [] }),
    });
    const result = await augment("how do I use the widget area?");

    expect(result).toBeNull();
    expect((mapper.map as jest.Mock)).not.toHaveBeenCalled();
    expect(search.search).not.toHaveBeenCalled();
  });

  it("per-call activation (B1): empty catalog first ⇒ null; same closure resolves once the catalog lands (no rebuild)", async () => {
    const mapper = fakeMapper({ features: ["widget"] });
    const search = fakeSearch([DEMO_ISSUE]);
    const catalogPath = writeCatalog({ features: [], flows: [] });

    const augment = buildAskJiraAugment({
      env: SYNTHETIC_CREDS,
      mapper,
      search,
      catalogPath,
    });

    // First call: empty catalog → null, mapper NOT called.
    expect(await augment("how do I use the widget area?")).toBeNull();
    expect((mapper.map as jest.Mock)).not.toHaveBeenCalled();

    // Catalog lands (same path) — NO factory rebuild.
    fs.writeFileSync(catalogPath, JSON.stringify(WIDGET_CATALOG), "utf8");

    const result = await augment("how do I use the widget area?");
    expect(result).not.toBeNull();
    expect(result!.issues).toEqual([DEMO_ISSUE]);
    expect((mapper.map as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(search.search).toHaveBeenCalledTimes(1);
  });

  it("kill-switch off (ASK_LABEL_AWARE=0): ⇒ null, mapper + search NOT called", async () => {
    const mapper = fakeMapper({ features: ["widget"] });
    const search = fakeSearch([DEMO_ISSUE]);

    const augment = buildAskJiraAugment({
      env: { ...SYNTHETIC_CREDS, ASK_LABEL_AWARE: "0" } as unknown as NodeJS.ProcessEnv,
      mapper,
      search,
      catalogPath: writeCatalog(WIDGET_CATALOG),
    });
    const result = await augment("how do I use the widget area?");

    expect(result).toBeNull();
    expect((mapper.map as jest.Mock)).not.toHaveBeenCalled();
    expect(search.search).not.toHaveBeenCalled();
  });

  it("Jira-error degrades gracefully: search.search throws ⇒ resolves null, NEVER throws", async () => {
    const mapper = fakeMapper({ features: ["widget"] });
    const search: JqlSearchFetcher = {
      search: jest.fn(async () => {
        throw new Error("jira boom");
      }),
    };

    const augment = buildAskJiraAugment({
      env: SYNTHETIC_CREDS,
      mapper,
      search,
      catalogPath: writeCatalog(WIDGET_CATALOG),
    });

    await expect(augment("how do I use the widget area?")).resolves.toBeNull();
  });

  it("no-defects ⇒ no section: area matches but search returns [] ⇒ null", async () => {
    const mapper = fakeMapper({ features: ["widget"] });
    const search = fakeSearch([]);

    const augment = buildAskJiraAugment({
      env: SYNTHETIC_CREDS,
      mapper,
      search,
      catalogPath: writeCatalog(WIDGET_CATALOG),
    });
    const result = await augment("how do I use the widget area?");

    expect(result).toBeNull();
    expect(search.search).toHaveBeenCalledTimes(1);
  });

  it("no creds (missing CONFLUENCE_API_TOKEN): ⇒ null, mapper + search NOT called", async () => {
    const mapper = fakeMapper({ features: ["widget"] });
    const search = fakeSearch([DEMO_ISSUE]);
    const env = {
      CONFLUENCE_URL: "https://demo.example.com",
      CONFLUENCE_EMAIL: "qa@example.com",
    } as unknown as NodeJS.ProcessEnv;

    const augment = buildAskJiraAugment({
      env,
      mapper,
      search,
      catalogPath: writeCatalog(WIDGET_CATALOG),
    });
    const result = await augment("how do I use the widget area?");

    expect(result).toBeNull();
    expect((mapper.map as jest.Mock)).not.toHaveBeenCalled();
    expect(search.search).not.toHaveBeenCalled();
  });

  it("bucket match (#1385 family): mapped family name resolves via featureBucketIds", async () => {
    const mapper = fakeMapper({ features: ["platform"] });
    const search = fakeSearch([DEMO_ISSUE]);
    const catalogPath = writeCatalog(WIDGET_CATALOG);
    const mapDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-augment-map-"));
    const mapPath = path.join(mapDir, "full-to-lean-map.json");
    fs.writeFileSync(
      mapPath,
      JSON.stringify({ features: { "feature-widget": "feature-platform" } }),
      "utf8",
    );

    const augment = buildAskJiraAugment({
      env: SYNTHETIC_CREDS,
      mapper,
      search,
      catalogPath,
      mapPath,
    });
    // Question shares the bucket stem "platform" so the lexical pre-gate passes.
    const result = await augment("how does the platform area behave?");

    expect(result).not.toBeNull();
    expect(result!.issues).toEqual([DEMO_ISSUE]);
    expect(search.search).toHaveBeenCalledTimes(1);
  });
});

describe("askAreaAugment (#1386) — parseAskDefectsMax", () => {
  it("unset ⇒ default 5", () => {
    expect(parseAskDefectsMax(undefined)).toBe(5);
  });
  it('"3" ⇒ 3', () => {
    expect(parseAskDefectsMax("3")).toBe(3);
  });
  it('non-numeric / "0" / "-2" ⇒ default 5', () => {
    expect(parseAskDefectsMax("abc")).toBe(5);
    expect(parseAskDefectsMax("0")).toBe(5);
    expect(parseAskDefectsMax("-2")).toBe(5);
  });
  it("clamps to the ceiling", () => {
    expect(parseAskDefectsMax("9999")).toBe(50);
  });
});

describe("askAreaAugment (#1386) — resolveCatalogMatches (pure)", () => {
  const vocab: LabelVocab = buildVocab(WIDGET_CATALOG);

  const filter = (f: Partial<StructuredFilter>): StructuredFilter => ({
    symptoms: [],
    features: [],
    flows: [],
    projects: [],
    ...f,
  });

  it("child hit returns the matched slug", () => {
    expect(resolveCatalogMatches(filter({ features: ["widget"] }), vocab)).toEqual(["widget"]);
  });

  it("bucket hit matches via featureBucketIds", () => {
    const leanVocab = buildVocab(
      WIDGET_CATALOG,
      undefined,
      new Map([["feature-widget", "feature-platform"]]),
    );
    expect(resolveCatalogMatches(filter({ features: ["platform"] }), leanVocab)).toEqual([
      "platform",
    ]);
  });

  it("miss on a populated catalog returns []", () => {
    expect(resolveCatalogMatches(filter({ features: ["nope"] }), vocab)).toEqual([]);
  });

  it("empty filter returns []", () => {
    expect(resolveCatalogMatches(filter({}), vocab)).toEqual([]);
  });

  it("empty vocab (no passthrough) returns []", () => {
    const emptyVocab = buildVocab({ features: [], flows: [] });
    expect(resolveCatalogMatches(filter({ features: ["widget"] }), emptyVocab)).toEqual([]);
  });
});
