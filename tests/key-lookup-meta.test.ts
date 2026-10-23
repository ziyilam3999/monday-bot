/**
 * #3307 — live issue-metadata suite (status / assignee / priority / resolution
 * / updated for exactly-named issue keys). All meta ACs live here.
 *
 * End-to-end through the SHARED funnel (`KnowledgeService.query`) with:
 *   - the jest hash-stub embedder (moduleNameMapper → tests/__stubs__/
 *     xenova-transformers.js — deterministic, same corpus as #3299);
 *   - a stubbed generator that echoes a FIXED answer string (assertions are on
 *     `query()`'s returned answer, so every facts value below is proven to be
 *     CODE-rendered, never model-invented) while recording the context it was
 *     called with and the result it returned;
 *   - a stubbed read-only one-issue fetcher returning checked-in fixture
 *     issues, OR the REAL fetchers (`buildJiraFetcher` / `buildIssueFetcher`)
 *     driven through a fake `fetchImpl` (no network) for the privacy and
 *     fields-lock arms;
 *   - checked-in fixtures ONLY (tests/fixtures/key-lookup/*, DEMO project key
 *     only). No live Jira, no LLM SDK, no environment file reads.
 *
 * RED-at-base method (plan AC-10): this file must COMPILE and RUN at pristine
 * origin/master (which already carries #3299), where `LiveIssue` carries no
 * meta and the one-issue fetcher requests no meta fields. That is why (a) every
 * static import names a module that exists there, (b) the service is
 * constructed through a type-erased factory, and (c) the stubbed live issues
 * are typed LOCALLY — at base the extra `meta` property is simply ignored, so
 * the must-fire arms fail on the MISSING facts line, not on an import.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { KnowledgeService } from "../src/knowledge/service";
import { Chunk as LlmChunk, Citation } from "../src/llm/generate";
import { buildJiraFetcher, buildIssueFetcher } from "../src/jira/sync";

jest.setTimeout(60_000);

// ---------------------------------------------------------------------------
// Checked-in fixtures
// ---------------------------------------------------------------------------

interface MetaLike {
  status?: string;
  assignee?: string | null;
  priority?: string | null;
  resolution?: string | null;
  updated?: string;
}

interface FixtureIssue {
  key: string;
  summary: string;
  descriptionText: string;
  commentTexts: string[];
  meta?: MetaLike;
}

interface CorpusIssue {
  key: string;
  summary: string;
  description: string;
  comments: string[];
}

const corpusFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "key-lookup", "repro-corpus.json"), "utf8"),
) as { projectKeys: string[]; target: CorpusIssue; neighbours: CorpusIssue[] };

const metaFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "key-lookup", "meta-issues.json"), "utf8"),
) as {
  projectKeys: string[];
  fullMeta: FixtureIssue;
  staleBody: { key: string; summary: string; description: string };
  liveFresh: FixtureIssue;
  sparseMeta: FixtureIssue;
  privacyPage: unknown;
  emptyPage: unknown;
};

/** Mirror JiraSync's body assembly so suite bodies match production shape. */
function bodyOf(issue: CorpusIssue): string {
  return [issue.key, issue.summary, issue.description, ...(issue.comments ?? [])]
    .filter(Boolean)
    .join("\n\n");
}

/** Index ONLY the neighbours — DEMO-673 stays UNINDEXED (live-fetch path). */
async function indexNeighbours(svc: KnowledgeService): Promise<void> {
  for (const issue of corpusFixture.neighbours) {
    await svc.indexConfluencePage({
      id: issue.key,
      title: issue.summary,
      body: bodyOf(issue),
      source: `jira:${issue.key}`,
      spaceKey: "DEMO",
    });
  }
}

/**
 * Index the neighbours PLUS DEMO-673 under the given body (the corpus default
 * is meta-free; the live-preferred arm passes the stale-embedding body).
 */
async function indexWithTarget(
  svc: KnowledgeService,
  targetBody: { key: string; summary: string; description: string },
): Promise<void> {
  await indexNeighbours(svc);
  await svc.indexConfluencePage({
    id: targetBody.key,
    title: targetBody.summary,
    body: [targetBody.key, targetBody.summary, targetBody.description]
      .filter(Boolean)
      .join("\n\n"),
    source: `jira:${targetBody.key}`,
    spaceKey: "DEMO",
  });
}

// ---------------------------------------------------------------------------
// Fixed-echo stub generator (records context AND its own returned result)
// ---------------------------------------------------------------------------

const STUB_ANSWER = "Stub retelling of the pinned chunks.";

interface GenCall {
  question: string;
  chunks: LlmChunk[];
}

type StubGenerator = (
  question: string,
  chunks: LlmChunk[],
) => Promise<{ answer: string; citations: Citation[] }>;

function makeGenerator(): {
  calls: GenCall[];
  returns: Array<{ answer: string; citations: Citation[] }>;
  generator: StubGenerator;
} {
  const calls: GenCall[] = [];
  const returns: Array<{ answer: string; citations: Citation[] }> = [];
  const generator: StubGenerator = async (question, chunks) => {
    calls.push({ question, chunks });
    const citations: Citation[] = chunks.map((c, i) => {
      const entry: Citation = { number: i + 1, source: c.source };
      if (c.heading) entry.heading = c.heading;
      return entry;
    });
    const result = { answer: STUB_ANSWER, citations };
    returns.push(result);
    return result;
  };
  return { calls, returns, generator };
}

/** Type-erased construction (RED-at-base pattern, see file header). */
function makeService(opts: { generator: StubGenerator; lookup?: unknown }): KnowledgeService {
  const bag: Record<string, unknown> = { generator: opts.generator };
  if (opts.lookup !== undefined) bag.issueLookup = opts.lookup;
  const Ctor = KnowledgeService as unknown as new (o?: Record<string, unknown>) => KnowledgeService;
  return new Ctor(bag);
}

// ---------------------------------------------------------------------------
// Stubbed read-only one-issue fetcher (records every call; fixture answers)
// ---------------------------------------------------------------------------

interface LiveIssueLike {
  key: string;
  summary: string;
  descriptionText: string;
  commentTexts: string[];
  meta?: MetaLike;
}

type Handler = LiveIssueLike | null | (() => Promise<LiveIssueLike | null>);

function makeFetcher(handlers: Record<string, Handler>): {
  calls: string[];
  fetcher: { fetchIssue(key: string): Promise<LiveIssueLike | null> };
} {
  const calls: string[] = [];
  const fetcher = {
    async fetchIssue(key: string): Promise<LiveIssueLike | null> {
      calls.push(key);
      const handler = handlers[key];
      if (typeof handler === "function") return await handler();
      return handler ?? null;
    },
  };
  return { calls, fetcher };
}

function lookupConfig(fetcher?: unknown): { projectKeys: string[]; issueFetcher?: unknown } {
  const cfg: { projectKeys: string[]; issueFetcher?: unknown } = {
    projectKeys: [...corpusFixture.projectKeys],
  };
  if (fetcher !== undefined) cfg.issueFetcher = fetcher;
  return cfg;
}

/** Minimal Response-shaped object for the fake `fetchImpl` arms (no network). */
function jsonResponse(body: unknown): unknown {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      return body;
    },
  };
}

// Every meta value any fixture carries — the AC-5 "no value appears" arm checks
// ALL of them in one loop.
const ALL_META_VALUES = [
  "In Progress",
  "Riley Demo",
  "High",
  "Fixed",
  "2026-10-18",
  "Open",
  "In Review",
  "Dana Demo",
  "Medium",
  "2026-10-16",
];

// ===========================================================================
// AC-2 — unindexed key: the live fetch supplies every rendered meta value
// ===========================================================================

describe("live meta (AC-2)", () => {
  it("live meta: unindexed DEMO-673 with the full fixture → answer contains EACH rendered value + a live-fetched note", async () => {
    const { calls: genCalls, generator } = makeGenerator();
    const { calls: fetchCalls, fetcher } = makeFetcher({ "DEMO-673": metaFixture.fullMeta });
    const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
    await indexNeighbours(svc);
    const result = await svc.query("What is the status of DEMO-673?");
    expect(fetchCalls).toEqual(["DEMO-673"]); // ONE fetch: text + facts, never two
    expect(genCalls.length).toBe(1);
    expect(result.answer).toContain("DEMO-673 — Status: In Progress");
    expect(result.answer).toContain("Assignee: Riley Demo");
    expect(result.answer).toContain("Priority: High");
    expect(result.answer).toContain("Resolution: Fixed");
    expect(result.answer).toContain("Updated: 2026-10-18");
    expect(result.answer).toContain("fetched from Jira just now"); // labelled live
  });
});

// ===========================================================================
// AC-3 — indexed stale body vs DIFFERENT live values: live preferred
// ===========================================================================

describe("live preferred (AC-3)", () => {
  it("live preferred: indexed body embeds STALE meta, fetcher returns DIFFERENT live values → answer shows the LIVE ones, pins still come from the index", async () => {
    const { calls: genCalls, generator } = makeGenerator();
    const { calls: fetchCalls, fetcher } = makeFetcher({ "DEMO-673": metaFixture.liveFresh });
    const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
    await indexWithTarget(svc, metaFixture.staleBody);
    const result = await svc.query("What is the status of DEMO-673?");
    expect(fetchCalls).toEqual(["DEMO-673"]); // indexed key STILL gets its one facts fetch
    expect(genCalls.length).toBe(1);
    // The pinned chunks are the INDEXED copy (with the stale values inside)…
    expect(genCalls[0].chunks[0].source).toBe("jira:DEMO-673");
    expect(genCalls[0].chunks[0].text).toContain("indexed copy");
    // …but the answer presents the LIVE values, never the stale ones.
    expect(result.answer).toContain("In Progress");
    expect(result.answer).toContain("Riley Demo");
    expect(result.answer).toContain("High");
    expect(result.answer).toContain("2026-10-18");
    expect(result.answer).not.toContain("Done");
    expect(result.answer).not.toContain("Old Owner");
    expect(result.answer).not.toContain("Low");
    expect(result.answer).not.toContain("2026-10-01");
  });
});

// ===========================================================================
// AC-4 — plain wordings for empty tracker values; nothing invented
// ===========================================================================

describe("plain unknown (AC-4)", () => {
  it("plain unknown: unassigned assignee, null resolution, ABSENT priority → Unassigned / Unresolved, no Priority segment, carried fields present", async () => {
    const { generator } = makeGenerator();
    const { calls: fetchCalls, fetcher } = makeFetcher({ "DEMO-673": metaFixture.sparseMeta });
    const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
    await indexNeighbours(svc);
    const result = await svc.query("What is the status of DEMO-673?");
    expect(fetchCalls).toEqual(["DEMO-673"]);
    // Fields the fixture carries are present…
    expect(result.answer).toContain("Status: Open");
    expect(result.answer).toContain("Updated: 2026-10-17");
    // …empty tracker values render as plain wordings (CODE-rendered — the
    // generator is a fixed echo, so no value below can be model-invented)…
    expect(result.answer).toContain("Assignee: Unassigned");
    expect(result.answer).toContain("Resolution: Unresolved");
    // …and the genuinely absent priority is omitted entirely, never guessed.
    expect(result.answer).not.toContain("Priority:");
  });
});

// ===========================================================================
// AC-5 — facts fetch rejects / exceeds its box for an INDEXED (meta-free) key
// ===========================================================================

const assertHonestMetaFailure = (
  result: { answer: string; citations: Citation[] },
  genChunks: LlmChunk[],
): void => {
  // The pinned retelling survives…
  expect(result.answer).toContain(STUB_ANSWER);
  expect(genChunks[0].source).toBe("jira:DEMO-673");
  expect(genChunks[0].text).toContain("Rotation handover checklist");
  // …a plain could-not-fetch line names the key…
  expect(result.answer).toMatch(/could not be fetched/);
  expect(result.answer).toContain("DEMO-673");
  // …and NO meta value from any fixture appears (the indexed body is meta-free,
  // so this assertion is decidable).
  for (const value of ALL_META_VALUES) {
    expect(result.answer).not.toContain(value);
  }
};

describe("meta failure honest (AC-5)", () => {
  it("meta failure honest (a): fetcher REJECTS for the indexed key → pinned retelling + could-not-fetch line, no meta value", async () => {
    const { calls: genCalls, generator } = makeGenerator();
    const reject = async (): Promise<LiveIssueLike | null> => {
      throw new Error("jira unreachable");
    };
    const { calls: fetchCalls, fetcher } = makeFetcher({ "DEMO-673": reject });
    const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
    await indexWithTarget(svc, {
      key: corpusFixture.target.key,
      summary: corpusFixture.target.summary,
      description: corpusFixture.target.description,
    });
    const result = await svc.query("What is the status of DEMO-673?");
    expect(fetchCalls).toEqual(["DEMO-673"]);
    expect(genCalls.length).toBe(1);
    assertHonestMetaFailure(result, genCalls[0].chunks);
  });

  it("meta failure honest (b): fetch exceeds its box (never resolves) → same honest outcome, past the 5 s per-fetch bound", async () => {
    const { calls: genCalls, generator } = makeGenerator();
    const never: () => Promise<LiveIssueLike | null> = () => new Promise(() => undefined);
    const { calls: fetchCalls, fetcher } = makeFetcher({ "DEMO-673": never });
    const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
    await indexWithTarget(svc, {
      key: corpusFixture.target.key,
      summary: corpusFixture.target.summary,
      description: corpusFixture.target.description,
    });
    jest.useFakeTimers();
    try {
      const pending = svc.query("What is the status of DEMO-673?");
      await jest.advanceTimersByTimeAsync(5_001);
      const result = await pending;
      expect(fetchCalls).toEqual(["DEMO-673"]);
      expect(genCalls.length).toBe(1);
      assertHonestMetaFailure(result, genCalls[0].chunks);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ===========================================================================
// AC-6 — non-key parity: issueLookup present changes NOTHING for key-free asks
// ===========================================================================

describe("parity (AC-6)", () => {
  it("parity: a question naming NO configured key → answer, citations AND generator chunks deep-equal the no-issueLookup service's", async () => {
    const genA = makeGenerator();
    const genB = makeGenerator();
    const { calls: fetchCalls, fetcher } = makeFetcher({ "DEMO-673": metaFixture.fullMeta });
    const svcWith = makeService({ generator: genA.generator, lookup: lookupConfig(fetcher) });
    const svcWithout = makeService({ generator: genB.generator });
    await indexNeighbours(svcWith);
    await indexNeighbours(svcWithout);
    const question = "How do I add a new deploy check?";
    const a = await svcWith.query(question);
    const b = await svcWithout.query(question);
    expect(fetchCalls).toEqual([]); // the leg never fired
    expect(a).toEqual(b); // answer + citations deep-equal
    expect(genA.calls[0].chunks).toEqual(genB.calls[0].chunks); // context deep-equal
  });
});

// ===========================================================================
// AC-7 — no fetcher configured: exactly today's (#3299) indexed answer
// ===========================================================================

describe("no fetcher (AC-7)", () => {
  it("no fetcher: indexed named key → query returns the stub generator's result VERBATIM (no prelude, no facts line, no unavailable line)", async () => {
    const { calls: genCalls, returns, generator } = makeGenerator();
    const svc = makeService({ generator, lookup: lookupConfig() }); // projects, NO fetcher
    await indexWithTarget(svc, {
      key: corpusFixture.target.key,
      summary: corpusFixture.target.summary,
      description: corpusFixture.target.description,
    });
    const result = await svc.query("What is the status of DEMO-673?");
    expect(genCalls.length).toBe(1);
    // Deep-equal to the plain #3299 indexed answer: the generator's own return,
    // byte-identical — nothing was prefixed or appended.
    expect(result).toEqual(returns[0]);
    expect(result.answer).toBe(STUB_ANSWER);
    expect(result.answer).not.toMatch(/live|fetched|could not/i);
  });
});

// ===========================================================================
// AC-8 — privacy: display name only, through the REAL one-issue fetcher
// ===========================================================================

describe("privacy (AC-8)", () => {
  it("privacy: REAL buildIssueFetcher + fake fetchImpl whose assignee carries displayName AND emailAddress → display name rendered, no @-shaped string", async () => {
    const { generator } = makeGenerator();
    const pages = [metaFixture.privacyPage];
    const fakeFetch = jest.fn(async () => jsonResponse(pages[0])) as unknown as typeof fetch;
    const realFetcher = buildIssueFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fakeFetch,
    );
    const svc = makeService({ generator, lookup: lookupConfig(realFetcher) });
    await indexNeighbours(svc); // DEMO-673 unindexed → the live leg runs
    const result = await svc.query("What is the status of DEMO-673?");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(result.answer).toContain("Dana Demo"); // display name rendered
    expect(result.answer).toContain("In Review");
    expect(result.answer).toContain("Unresolved");
    // No email shape anywhere in the channel-visible answer.
    expect(result.answer).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(result.answer).not.toContain("emailAddress");
  });
});

// ===========================================================================
// AC-9 — fields lock: sync fetcher keeps TODAY's list, one-issue fetcher widened
// ===========================================================================

describe("fields lock (AC-9)", () => {
  const fieldsParam = (url: string): string | undefined =>
    /[?&]fields=([^&]+)/.exec(url)?.[1];

  it("fields lock: REAL knowledge-sync fetcher asks for EXACTLY today's fields; REAL one-issue fetcher asks for the WIDENED list", async () => {
    const urls: string[] = [];
    const pages = [metaFixture.emptyPage, metaFixture.privacyPage]; // 1st: sync, 2nd: one-issue
    let calls = 0;
    const fakeFetch = jest.fn(async (url: string) => {
      urls.push(url);
      const page = pages[calls];
      calls++;
      return jsonResponse(page);
    }) as unknown as typeof fetch;
    const config = { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" };

    const syncFetcher = buildJiraFetcher(config, fakeFetch);
    const syncIssues = await syncFetcher.fetchIssues("DEMO");
    expect(syncIssues).toEqual([]); // empty page → no issues, no meta mapped
    expect(urls.length).toBe(1);
    expect(fieldsParam(urls[0])).toBe("summary,description,comment");
    expect(urls[0]).toContain("maxResults=100");
    expect(decodeURIComponent(urls[0])).toContain("project=DEMO");

    urls.length = 0;
    const oneFetcher = buildIssueFetcher(config, fakeFetch);
    // Type-erased (RED-at-base): `meta` is a #3307 field that does not exist on
    // the base JiraIssue — the access goes through this local shape so the file
    // COMPILES at base and the arm fails there on the assertion, not the import.
    const issue = (await oneFetcher.fetchIssue("DEMO-673")) as unknown as {
      meta?: unknown;
    } | null;
    expect(urls.length).toBe(1);
    expect(fieldsParam(urls[0])).toBe(
      "summary,description,comment,status,assignee,priority,resolution,updated",
    );
    expect(urls[0]).toContain("maxResults=1");
    expect(decodeURIComponent(urls[0])).toContain("key = DEMO-673");
    // The widened fetch maps the meta — display name only, nulls kept as nulls.
    expect(issue).not.toBeNull();
    expect(issue?.meta).toEqual({
      status: "In Review",
      assignee: "Dana Demo",
      priority: "Medium",
      resolution: null,
      updated: "2026-10-16T08:00:00.000+0000",
    });
  });

  it("fields lock: the sync fetcher maps NO meta from a meta-free page (indexed body unchanged)", async () => {
    const page = {
      issues: [
        {
          key: "DEMO-674",
          fields: {
            summary: "Intake notes",
            description: "plain body",
            comment: { comments: [] },
            project: { key: "DEMO" },
          },
        },
      ],
      isLast: true,
    };
    const fakeFetch = jest.fn(async () => jsonResponse(page)) as unknown as typeof fetch;
    const syncFetcher = buildJiraFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fakeFetch,
    );
    // Type-erased for the same RED-at-base reason as above.
    const issues = (await syncFetcher.fetchIssues("DEMO")) as unknown as Array<{
      meta?: unknown;
    }>;
    expect(issues).toHaveLength(1);
    expect(issues[0].meta).toBeUndefined();
  });
});

// ===========================================================================
// #3378 — the operator's field-phrase question reaches the live facts line
// ===========================================================================

describe("3378 field phrase end-to-end", () => {
  it("3378: 'what's the status of get 673?' → live facts line, one fetch of GET-673", async () => {
    const { generator } = makeGenerator();
    const { calls: fetchCalls, fetcher } = makeFetcher({
      "GET-673": {
        key: "GET-673",
        summary: "Fixture summary",
        descriptionText: "Fixture description",
        commentTexts: [],
        meta: { status: "In Progress" },
      },
    });
    const svc = makeService({
      generator,
      lookup: { projectKeys: ["GET"], issueFetcher: fetcher },
    });
    await indexNeighbours(svc);
    const result = await svc.query("Hi Monday, what's the status of get 673?");
    expect(fetchCalls).toEqual(["GET-673"]);
    expect(result.answer).toContain("GET-673 — Status: In Progress");
  });
});
