/**
 * #3299 — exact issue-key lookup suite (all ACs).
 *
 * End-to-end through the SHARED funnel (KnowledgeService.query → retrieve →
 * generator; Slack handleQuery; Telegram adapter processUpdate) with:
 *   - the jest hash-stub embedder (moduleNameMapper → tests/__stubs__/
 *     xenova-transformers.js — deterministic; reproduces the repro SHAPE:
 *     neighbours outrank the named key at base);
 *   - a stubbed read-only one-issue fetcher that records every call and
 *     returns checked-in fixture issues;
 *   - checked-in fixtures ONLY (tests/fixtures/key-lookup/*). No live Jira, no
 *     LLM SDK, no environment file reads — enforced by the AC-9 grep.
 *
 * RED-at-base method (plan AC-3): this file must COMPILE and its "repro shape"
 * arm must RUN at the branch point (6873485), where src/knowledge/keyLookup.ts
 * does not exist. That is why (a) every static import names a module that
 * exists at base, (b) the new module is loaded through a lazy `require` inside
 * the arms that need it, and (c) the service is constructed through a
 * type-erased factory so the #3299 `issueLookup` option is not a compile error
 * at base (base ignores it → pure vector path → the assertion fails, not the
 * import).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { KnowledgeService } from "../src/knowledge/service";
import { Chunk as LlmChunk, Citation } from "../src/llm/generate";
import { handleQuery } from "../src/slack/queryHandler";
import { TelegramAdapter } from "../src/telegram/adapter";
import { TelegramTransport, TgUpdate } from "../src/telegram/transport";

jest.setTimeout(60_000);

// ---------------------------------------------------------------------------
// Lazy access to the NEW module (see file header — must not be a static import
// or the RED-at-base run would fail on a missing module, not an assertion).
// ---------------------------------------------------------------------------

type ExtractIssueKeysFn = (question: string, projectKeys: readonly string[]) => string[];

function extractKeys(question: string, projectKeys: string[]): string[] {
  const mod = require("../src/knowledge/keyLookup") as {
    extractIssueKeys: ExtractIssueKeysFn;
  };
  return mod.extractIssueKeys(question, projectKeys);
}

// ---------------------------------------------------------------------------
// Checked-in fixtures
// ---------------------------------------------------------------------------

interface FixtureIssue {
  key: string;
  summary: string;
  description: string;
  comments: string[];
}

const corpusFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "key-lookup", "repro-corpus.json"), "utf8"),
) as { projectKeys: string[]; target: FixtureIssue; neighbours: FixtureIssue[] };

interface ParityReceipt {
  recordedAt: string;
  questions: Array<{
    question: string;
    results: Array<{ id: string; source: string; score: number }>;
  }>;
}

const parityReceipt = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "key-lookup", "parity-receipt.json"), "utf8"),
) as ParityReceipt;

/** Mirror JiraSync's body assembly so suite bodies match production shape. */
function bodyOf(issue: FixtureIssue): string {
  return [issue.key, issue.summary, issue.description, ...(issue.comments ?? [])]
    .filter(Boolean)
    .join("\n\n");
}

/** Index the fixture corpus exactly the way the Jira sync does. */
async function indexCorpus(svc: KnowledgeService): Promise<void> {
  for (const issue of [corpusFixture.target, ...corpusFixture.neighbours]) {
    await svc.indexConfluencePage({
      id: issue.key,
      title: issue.summary,
      body: bodyOf(issue),
      source: `jira:${issue.key}`,
      spaceKey: "GET",
    });
  }
}

// ---------------------------------------------------------------------------
// Stub generator (records the CONTEXT it was called with) + service factory
// ---------------------------------------------------------------------------

interface GenCall {
  question: string;
  chunks: LlmChunk[];
}

type StubGenerator = (
  question: string,
  chunks: LlmChunk[],
) => Promise<{ answer: string; citations: Citation[] }>;

function makeGenerator(): { calls: GenCall[]; generator: StubGenerator } {
  const calls: GenCall[] = [];
  const generator: StubGenerator = async (question, chunks) => {
    calls.push({ question, chunks });
    const citations: Citation[] = chunks.map((c, i) => {
      const entry: Citation = { number: i + 1, source: c.source };
      if (c.heading) entry.heading = c.heading;
      return entry;
    });
    // The answer names each context source in order, so both the Slack and the
    // Telegram arms can assert CONTEXT ORDER from the channel-visible text.
    const answer = chunks.map((c, i) => `[${i + 1}] ${c.source}`).join(" ");
    return { answer, citations };
  };
  return { calls, generator };
}

/**
 * Type-erased construction: `issueLookup` is a #3299 option that does not
 * exist at the branch point, so the options bag is assembled as an untyped
 * record and cast (see file header — RED-at-base compatibility).
 */
function makeService(opts: {
  generator: StubGenerator;
  lookup?: unknown;
  now?: () => number;
}): KnowledgeService {
  const bag: Record<string, unknown> = { generator: opts.generator };
  if (opts.lookup !== undefined) bag.issueLookup = opts.lookup;
  if (opts.now !== undefined) bag.now = opts.now;
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

/** The #3299 wiring shape used by every funnel arm: GET projects + stub fetcher. */
function lookupConfig(fetcher?: unknown): { projectKeys: string[]; issueFetcher?: unknown } {
  const cfg: { projectKeys: string[]; issueFetcher?: unknown } = {
    projectKeys: [...corpusFixture.projectKeys],
  };
  if (fetcher !== undefined) cfg.issueFetcher = fetcher;
  return cfg;
}

// ---------------------------------------------------------------------------
// Telegram fake transport (captures sends; never any network)
// ---------------------------------------------------------------------------

class CaptureTransport implements TelegramTransport {
  sent: Array<{ chatId: number; text: string }> = [];
  async getUpdates(_offset: number, _timeoutSec: number): Promise<TgUpdate[]> {
    return [];
  }
  async sendMessage(chatId: number, text: string): Promise<unknown> {
    this.sent.push({ chatId, text });
    return { ok: true };
  }
}

const TMP_DIRS: string[] = [];
function tmpAskLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "key-lookup-asklog-"));
  TMP_DIRS.push(dir);
  return path.join(dir, "ask-log.jsonl");
}
afterAll(() => {
  for (const dir of TMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// AC-2 — extraction, per shape, for the fixture project list
// ===========================================================================

describe("extraction (AC-2)", () => {
  const PROJECTS = ["GET"];

  it("extraction (a): hyphenated fires with NO context word, any case, canonical casing", () => {
    expect(extractKeys("GET-673", PROJECTS)).toEqual(["GET-673"]);
    expect(extractKeys("get-673", PROJECTS)).toEqual(["GET-673"]);
    expect(extractKeys("status of Get-673 please", PROJECTS)).toEqual(["GET-673"]);
  });

  it("extraction (b): inside a Jira-context sentence the spaced and fused forms resolve to the SAME canonical key", () => {
    expect(extractKeys("Can you extract Jira Get 673?", PROJECTS)).toEqual(["GET-673"]);
    expect(extractKeys("can you show the jira GET 673 summary", PROJECTS)).toEqual(["GET-673"]);
    expect(extractKeys("Jira get673 status", PROJECTS)).toEqual(["GET-673"]);
    expect(extractKeys("what does ticket GET 673 say", PROJECTS)).toEqual(["GET-673"]);
    expect(extractKeys("the issue Get 673 broke again", PROJECTS)).toEqual(["GET-673"]);
  });

  it("extraction (c): with NO context word, spaced and fused forms resolve to NOTHING", () => {
    expect(extractKeys("Get 673 please", PROJECTS)).toEqual([]);
    expect(extractKeys("get673 now", PROJECTS)).toEqual([]);
    expect(extractKeys("tell me about GET 673", PROJECTS)).toEqual([]);
  });

  it("extraction (d): a bare number with no project prefix resolves to NOTHING", () => {
    expect(extractKeys("what about 673 yesterday?", PROJECTS)).toEqual([]);
    expect(extractKeys("673", PROJECTS)).toEqual([]);
  });

  it("extraction (e): an unconfigured project prefix resolves to NOTHING", () => {
    expect(extractKeys("XYZ-673 status?", PROJECTS)).toEqual([]);
    expect(extractKeys("jira XYZ 673 status?", PROJECTS)).toEqual([]);
  });

  it("extraction: prefixes match case-insensitively and the canonical casing comes from the configured list", () => {
    expect(extractKeys("ops-42 and ops-43", ["OPS"])).toEqual(["OPS-42", "OPS-43"]);
    expect(extractKeys("jira get 43 and GET-42", ["get"])).toEqual(["get-43", "get-42"]);
  });

  it("extraction: keys are distinct, first-mention order, number is a standalone digit run", () => {
    expect(extractKeys("GET-673 and GET-674 and GET-673 again", PROJECTS)).toEqual([
      "GET-673",
      "GET-674",
    ]);
    // glued letters / longer numbers are not key numbers
    expect(extractKeys("forget-673 is not a key", PROJECTS)).toEqual([]);
    expect(extractKeys("GET-673a nope", PROJECTS)).toEqual([]);
    expect(extractKeys("GET-673.5 nope", PROJECTS)).toEqual([]);
    expect(extractKeys("GET, 673 nope", PROJECTS)).toEqual([]);
  });
});

// ===========================================================================
// Shared funnel helpers (both-ends arms below)
// ===========================================================================

/** A checked-in live-issue answer for an unindexed key (AC-5/AC-10/AC-11). */
const LIVE_GET_900: LiveIssueLike = {
  key: "GET-900",
  summary: "Freshly filed rollback drill",
  descriptionText:
    "GET-900 rollback drill kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey.",
  commentTexts: [],
};

function liveIssueFor(key: string): LiveIssueLike {
  return {
    key,
    summary: `Freshly filed ${key} drill`,
    descriptionText: `${key} freshly filed drill alpha bravo charlie delta echo foxtrot golf hotel india juliet.`,
    commentTexts: [],
  };
}

/**
 * AC-7's per-arm funnel check: the question extracts ZERO keys, calls the
 * stubbed fetcher ZERO times, and the generator context is EXACTLY the plain
 * vector retrieval (ids + sources in order) — nothing pinned.
 */
async function assertDoesNotFire(question: string): Promise<void> {
  expect(extractKeys(question, corpusFixture.projectKeys)).toEqual([]);
  const { calls: genCalls, generator } = makeGenerator();
  const { calls: fetchCalls, fetcher } = makeFetcher({});
  const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
  await indexCorpus(svc);
  const retrieval = await svc.retrieve(question);
  await svc.query(question);
  expect(fetchCalls).toEqual([]);
  expect(genCalls.length).toBe(1);
  expect(genCalls[0].chunks.map((c) => c.id)).toEqual(retrieval.map((r) => r.id));
  expect(genCalls[0].chunks.map((c) => c.source)).toEqual(retrieval.map((r) => r.source));
}

// ===========================================================================
// AC-3 — both-ends repro shape (RED at base 6873485; see file header)
// ===========================================================================

describe("repro shape (AC-3)", () => {
  it("repro shape: 'Can you extract Jira Get 673?' is answered from GET-673's own chunks", async () => {
    const { calls: genCalls, generator } = makeGenerator();
    const svc = makeService({ generator, lookup: lookupConfig() });
    await indexCorpus(svc);
    const result = await svc.query("Can you extract Jira Get 673?");
    // At base the generator IS called (pure vector path) — the RED falls on
    // the key-not-in-context assertion just below, not on a missing call.
    expect(genCalls.length).toBe(1);
    const sources = genCalls[0].chunks.map((c) => c.source);
    expect(sources).toContain("jira:GET-673");
    expect(sources[0]).toBe("jira:GET-673");
    expect(result.citations[0]?.source).toBe("jira:GET-673");
    expect(result.answer).toContain("jira:GET-673");
  });
});

// ===========================================================================
// AC-4 — indexed key pinned FIRST, total context still 12, both channel ends
// ===========================================================================

describe("indexed-first (AC-4)", () => {
  it("indexed: named issue's chunks lead the generator context; total context is still 12", async () => {
    const { calls: genCalls, generator } = makeGenerator();
    const svc = makeService({ generator, lookup: lookupConfig() });
    await indexCorpus(svc);
    const result = await svc.query("Can you extract Jira Get 673?");
    expect(genCalls.length).toBe(1);
    const chunks = genCalls[0].chunks;
    expect(chunks.length).toBe(12);
    expect(chunks[0].source).toBe("jira:GET-673");
    expect(chunks[0].score).toBe(1); // pinned by name, not vector similarity
    expect(chunks[0].text).toContain("Rotation handover checklist");
    expect(result.citations[0]?.source).toBe("jira:GET-673");
  });

  it("indexed: Slack handleQuery path — pinned source first in the Slack payload", async () => {
    const { generator } = makeGenerator();
    const svc = makeService({ generator, lookup: lookupConfig() });
    await indexCorpus(svc);
    const payload = await handleQuery("Can you extract Jira Get 673?", svc);
    expect(payload.text).toContain("jira:GET-673");
    expect(payload.text.indexOf("jira:GET-673")).toBeLessThan(payload.text.indexOf("jira:GET-674"));
  });

  it("indexed: Telegram adapter path — pinned source first in the sent reply", async () => {
    const { generator } = makeGenerator();
    const svc = makeService({ generator, lookup: lookupConfig() });
    await indexCorpus(svc);
    const transport = new CaptureTransport();
    const adapter = new TelegramAdapter({
      botToken: "test-token",
      allowedChatIds: [42],
      knowledgeService: svc,
      transportFactory: () => transport,
      askLogPath: tmpAskLogPath(),
    });
    await adapter.processUpdate({
      update_id: 1,
      message: { chat: { id: 42 }, text: "Can you extract Jira Get 673?" },
    } as TgUpdate);
    expect(transport.sent.length).toBe(1);
    const text = transport.sent[0].text;
    expect(text).toContain("jira:GET-673");
    expect(text.indexOf("jira:GET-673")).toBeLessThan(text.indexOf("jira:GET-674"));
  });
});

// ===========================================================================
// AC-5 — live fill for an unindexed key
// ===========================================================================

describe("live fill (AC-5)", () => {
  it("live: unindexed key → ONE fetch of exactly that key; text in context (≤3 chunks); NOT indexed; answer says live", async () => {
    const { calls: genCalls, generator } = makeGenerator();
    const { calls: fetchCalls, fetcher } = makeFetcher({ "GET-900": LIVE_GET_900 });
    const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
    await indexCorpus(svc);
    const result = await svc.query("ticket GET-900 status");
    expect(fetchCalls).toEqual(["GET-900"]);
    expect(genCalls.length).toBe(1);
    const chunks = genCalls[0].chunks;
    const liveChunks = chunks.filter((c) => c.source === "jira:GET-900");
    expect(liveChunks.length).toBeGreaterThan(0);
    expect(liveChunks.length).toBeLessThanOrEqual(3);
    expect(chunks[0].source).toBe("jira:GET-900");
    expect(liveChunks[0].text).toContain("rollback drill");
    expect(result.answer).toMatch(/live/i);
    expect(result.answer).toContain("GET-900");
    // NOT added to the index: the same question fetches again (no cached pin)
    await svc.query("ticket GET-900 status");
    expect(fetchCalls).toEqual(["GET-900", "GET-900"]);
  });
});

// ===========================================================================
// AC-6 — honest miss when Jira hands back nothing
// ===========================================================================

describe("not found (AC-6)", () => {
  it("not found: no issue returned → honest answer naming the key; no neighbours, no citations, no generator call", async () => {
    const { calls: genCalls, generator } = makeGenerator();
    const { calls: fetchCalls, fetcher } = makeFetcher({}); // every key → null
    const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
    await indexCorpus(svc);
    const result = await svc.query("GET-901 status");
    expect(fetchCalls).toEqual(["GET-901"]);
    expect(result.answer).toContain("GET-901");
    expect(result.answer).toMatch(/not found or not visible/i);
    expect(result.citations).toEqual([]);
    expect(genCalls.length).toBe(0); // no vector-derived substitute answer
    for (const n of corpusFixture.neighbours.slice(0, 4)) {
      expect(result.answer).not.toContain(n.key);
    }
  });
});

// ===========================================================================
// AC-7 — must-not-fire prose arms
// ===========================================================================

describe("must-not-fire (AC-7)", () => {
  it("must-not-fire (1): no key at all", async () => {
    await assertDoesNotFire("How do I add a new deploy check?");
  });
  it("must-not-fire (2): word-like key + number, no Jira context", async () => {
    await assertDoesNotFire("Can I get 2 volunteers to review the doc?");
  });
  it("must-not-fire (3): context word AFTER the number", async () => {
    await assertDoesNotFire("I need to get 3 tickets for the jira talk");
  });
  it("must-not-fire (4): bare number", async () => {
    await assertDoesNotFire("what happened to 673 yesterday?");
  });
  it("must-not-fire (5): unconfigured project", async () => {
    await assertDoesNotFire("ABC-673 status?");
  });
});

// ===========================================================================
// AC-8 — no-key parity against the frozen-at-base receipt (recorded at 6873485)
// ===========================================================================

describe("parity (AC-8)", () => {
  it("parity: key-free questions retrieve identically to the base receipt (ids, sources, order; scores within 1e-6)", async () => {
    const { generator } = makeGenerator();
    const svc = makeService({ generator, lookup: lookupConfig() });
    await indexCorpus(svc);
    expect(parityReceipt.questions.length).toBeGreaterThanOrEqual(6);
    for (const q of parityReceipt.questions) {
      const results = await svc.retrieve(q.question);
      expect(results.map((r) => r.id)).toEqual(q.results.map((r) => r.id));
      expect(results.map((r) => r.source)).toEqual(q.results.map((r) => r.source));
      q.results.forEach((expected, i) => {
        expect(Math.abs(results[i].score - expected.score)).toBeLessThanOrEqual(1e-6);
      });
    }
  });
});

// ===========================================================================
// AC-10 — multi-key pinning, fetch, and the 3-key cap
// ===========================================================================

describe("multi-key (AC-10)", () => {
  it("multi-key (a): two indexed keys pinned ahead of all vector hits, first-mention order, total 12", async () => {
    const { calls: genCalls, generator } = makeGenerator();
    const svc = makeService({ generator, lookup: lookupConfig() });
    await indexCorpus(svc);
    await svc.query("GET-673 and GET-674");
    expect(genCalls.length).toBe(1);
    const chunks = genCalls[0].chunks;
    expect(chunks.length).toBe(12);
    expect(chunks[0].source).toBe("jira:GET-673");
    expect(chunks[0].score).toBe(1);
    expect(chunks[1].source).toBe("jira:GET-674");
    expect(chunks[1].score).toBe(1);
  });

  it("multi-key (b): one indexed + one unindexed → exactly ONE fetch, for the unindexed key only", async () => {
    const { generator } = makeGenerator();
    const { calls: fetchCalls, fetcher } = makeFetcher({ "GET-900": LIVE_GET_900 });
    const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
    await indexCorpus(svc);
    await svc.query("GET-673 and GET-900");
    expect(fetchCalls).toEqual(["GET-900"]);
  });

  it("multi-key (c): four unindexed keys → fetcher called for EXACTLY the first three, in order", async () => {
    const { generator } = makeGenerator();
    const { calls: fetchCalls, fetcher } = makeFetcher({
      "GET-900": liveIssueFor("GET-900"),
      "GET-901": liveIssueFor("GET-901"),
      "GET-902": liveIssueFor("GET-902"),
      "GET-903": liveIssueFor("GET-903"),
    });
    const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
    await indexCorpus(svc);
    await svc.query("GET-900 and GET-901 and GET-902 and GET-903");
    expect(fetchCalls).toEqual(["GET-900", "GET-901", "GET-902"]);
  });
});

// ===========================================================================
// AC-11 — fetch time bound (fake timers)
// ===========================================================================

describe("timeout (AC-11)", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("timeout (a): never-resolving fetch → query resolved past the 5 s bound with an honest timed-out answer, no substitute", async () => {
    const { calls: genCalls, generator } = makeGenerator();
    const never: () => Promise<LiveIssueLike | null> = () => new Promise(() => undefined);
    const { calls: fetchCalls, fetcher } = makeFetcher({ "GET-900": never });
    const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
    await indexCorpus(svc);
    jest.useFakeTimers();
    const pending = svc.query("ticket GET-900 status");
    await jest.advanceTimersByTimeAsync(5_001);
    const result = await pending;
    expect(fetchCalls).toEqual(["GET-900"]);
    expect(result.answer).toContain("GET-900");
    expect(result.answer).toMatch(/timed out/i);
    expect(result.citations).toEqual([]); // zero neighbouring citations
    expect(genCalls.length).toBe(0); // no vector substitute
  });

  it("timeout (b): two never-resolving fetches → resolved by the 10 s whole-live-leg bound, honest answer covering BOTH keys", async () => {
    const { calls: genCalls, generator } = makeGenerator();
    const never: () => Promise<LiveIssueLike | null> = () => new Promise(() => undefined);
    const { calls: fetchCalls, fetcher } = makeFetcher({
      "GET-900": never,
      "GET-901": never,
    });
    const svc = makeService({ generator, lookup: lookupConfig(fetcher) });
    await indexCorpus(svc);
    jest.useFakeTimers();
    const pending = svc.query("GET-900 and GET-901");
    await jest.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(fetchCalls).toEqual(["GET-900", "GET-901"]);
    expect(result.answer).toContain("GET-900");
    expect(result.answer).toContain("GET-901");
    expect(result.answer).toMatch(/timed out/i);
    expect(result.citations).toEqual([]);
    expect(genCalls.length).toBe(0);
  });
});
