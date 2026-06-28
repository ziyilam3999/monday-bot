import * as fs from "node:fs";
import * as path from "node:path";

import {
  ConfluenceSync,
  ConfluenceFetcher,
  ConfluencePage,
  buildConfluenceFetcher,
  MAX_PAGES,
} from "../src/confluence/sync";
import { KnowledgeService } from "../src/knowledge/service";
import { Chunk as LlmChunk, Citation } from "../src/llm/generate";

jest.setTimeout(30_000);

function makeStubFetcher(pagesBySpace: Record<string, ConfluencePage[]>): ConfluenceFetcher {
  return {
    async fetchPages(spaceKey: string) {
      return pagesBySpace[spaceKey] ?? [];
    },
  };
}

describe("ConfluenceSync module exports", () => {
  it("exports a ConfluenceSync class with a syncSpace method", () => {
    expect(typeof ConfluenceSync).toBe("function");
    const fetcher = makeStubFetcher({});
    const knowledge = new KnowledgeService();
    const sync = new ConfluenceSync({ knowledge, fetcher });
    expect(typeof sync.syncSpace).toBe("function");
  });

  it("rejects construction without knowledge or fetcher", () => {
    expect(() => new ConfluenceSync({} as unknown as { knowledge: KnowledgeService; fetcher: ConfluenceFetcher })).toThrow(TypeError);
  });
});

describe("ConfluenceSync.syncSpace happy path", () => {
  it("routes each fetched page through KnowledgeService.indexConfluencePage", async () => {
    const knowledge = new KnowledgeService();
    const pages: ConfluencePage[] = [
      { id: "page-100", title: "Onboarding", body: "Welcome to the team.", source: "confluence:page-100", spaceKey: "HR" },
      { id: "page-101", title: "Benefits", body: "401k matches up to 5%.", source: "confluence:page-101", spaceKey: "HR" },
    ];
    const fetcher = makeStubFetcher({ HR: pages });
    const sync = new ConfluenceSync({ knowledge, fetcher });

    const result = await sync.syncSpace("HR");

    expect(result.spaceKey).toBe("HR");
    expect(result.pagesIndexed).toBe(2);
    expect(result.pagesFailed).toBe(0);
    expect(knowledge.getStatus().documentCount).toBe(2);
    expect(knowledge.getChunkCountForSource("confluence:page-100")).toBe(1);
    expect(knowledge.getChunkCountForSource("confluence:page-101")).toBe(1);
  });

  it("counts failures without aborting the rest of the batch", async () => {
    const knowledge = new KnowledgeService();
    const indexSpy = jest
      .spyOn(knowledge, "indexConfluencePage")
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => undefined);

    const pages: ConfluencePage[] = [
      { id: "p1", title: "A", body: "first", source: "confluence:p1" },
      { id: "p2", title: "B", body: "second", source: "confluence:p2" },
    ];
    const fetcher = makeStubFetcher({ X: pages });
    const errorLog = jest.fn();
    const sync = new ConfluenceSync({
      knowledge,
      fetcher,
      logger: { error: errorLog },
    });

    const result = await sync.syncSpace("X");
    expect(result.pagesIndexed).toBe(1);
    expect(result.pagesFailed).toBe(1);
    expect(indexSpy).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("rejects empty spaceKey", async () => {
    const knowledge = new KnowledgeService();
    const fetcher = makeStubFetcher({});
    const sync = new ConfluenceSync({ knowledge, fetcher });
    await expect(sync.syncSpace("")).rejects.toThrow(TypeError);
  });
});

describe("KnowledgeService.indexConfluencePage replace-on-resync", () => {
  it("replaces the prior version of the same page (no duplicate chunks)", async () => {
    const knowledge = new KnowledgeService();
    const page = {
      id: "page-001",
      title: "IT Policies",
      body: "Password must be 12 characters.",
      source: "confluence:page-001",
      spaceKey: "IT",
    };
    await knowledge.indexConfluencePage(page);
    expect(knowledge.getChunkCountForSource("confluence:page-001")).toBe(1);
    expect(knowledge.getStatus().documentCount).toBe(1);

    await knowledge.indexConfluencePage({
      ...page,
      body: "Password must be 16 characters now.",
    });

    // After re-sync, exactly one chunk should remain for this source.
    expect(knowledge.getChunkCountForSource("confluence:page-001")).toBe(1);
    expect(knowledge.getStatus().documentCount).toBe(1);
  });

  it("re-syncing through ConfluenceSync.syncSpace also dedupes by source", async () => {
    const knowledge = new KnowledgeService();
    const v1: ConfluencePage[] = [
      { id: "policy", title: "Policy", body: "v1 body", source: "confluence:policy", spaceKey: "IT" },
    ];
    const v2: ConfluencePage[] = [
      { id: "policy", title: "Policy", body: "v2 body", source: "confluence:policy", spaceKey: "IT" },
    ];
    const state: { current: ConfluencePage[] } = { current: v1 };
    const fetcher: ConfluenceFetcher = {
      async fetchPages() {
        return state.current;
      },
    };
    const sync = new ConfluenceSync({ knowledge, fetcher });
    await sync.syncSpace("IT");
    expect(knowledge.getChunkCountForSource("confluence:policy")).toBe(1);
    state.current = v2;
    await sync.syncSpace("IT");
    expect(knowledge.getChunkCountForSource("confluence:policy")).toBe(1);
  });

  it("answers from the new version after re-sync (generator sees new body only)", async () => {
    const generator = jest.fn(async (_q: string, chunks: LlmChunk[]) => {
      const citations: Citation[] = chunks.map((c, i) => ({ number: i + 1, source: c.source }));
      return { answer: chunks.map((c) => c.text).join(" | "), citations };
    });
    const knowledge = new KnowledgeService({ generator });

    await knowledge.indexConfluencePage({
      id: "p1",
      title: "Pwd",
      body: "Password must be 12 characters.",
      source: "confluence:p1",
    });
    await knowledge.indexConfluencePage({
      id: "p1",
      title: "Pwd",
      body: "Password must be 16 characters now.",
      source: "confluence:p1",
    });

    const r = await knowledge.query("password length requirement");
    expect(r.answer).toContain("16");
    expect(r.answer).not.toContain("12");
  });

  it("rejects malformed input shapes", async () => {
    const knowledge = new KnowledgeService();
    await expect(
      knowledge.indexConfluencePage(null as unknown as { id: string; body: string }),
    ).rejects.toThrow(TypeError);
    await expect(
      knowledge.indexConfluencePage({ id: "", body: "x" } as unknown as { id: string; body: string }),
    ).rejects.toThrow(TypeError);
    await expect(
      knowledge.indexConfluencePage({ id: "ok", body: 123 as unknown as string }),
    ).rejects.toThrow(TypeError);
  });

  it("treats blank body as a delete (drops prior chunks, leaves source unindexed)", async () => {
    const knowledge = new KnowledgeService();
    await knowledge.indexConfluencePage({
      id: "p2",
      title: "T",
      body: "real content",
      source: "confluence:p2",
    });
    expect(knowledge.getChunkCountForSource("confluence:p2")).toBe(1);

    await knowledge.indexConfluencePage({
      id: "p2",
      title: "T",
      body: "   ",
      source: "confluence:p2",
    });
    expect(knowledge.getChunkCountForSource("confluence:p2")).toBe(0);
  });
});

describe("KnowledgeService.indexConfluencePage passage-chunking (AC4, #1189)", () => {
  function longBody(): string {
    // ~3500 chars of sentences on a single collapsed line (mirrors stripHtml
    // output) so the chunker produces several passages.
    const sentences: string[] = [];
    for (let i = 0; i < 80; i++) {
      sentences.push(`Step ${i} explains a part of the onboarding workflow in detail.`);
    }
    return sentences.join(" ");
  }

  it("a long page produces > 1 chunk under the same source", async () => {
    const knowledge = new KnowledgeService();
    await knowledge.indexConfluencePage({
      id: "long-1",
      title: "Big How-To",
      body: longBody(),
      source: "confluence:long-1",
      spaceKey: "ENG",
    });
    expect(knowledge.getChunkCountForSource("confluence:long-1")).toBeGreaterThan(1);
    // The page still counts as exactly ONE document (source), not N.
    expect(knowledge.getStatus().documentCount).toBe(1);
  });

  it("re-syncing a long page replaces (not duplicates) its chunks", async () => {
    const knowledge = new KnowledgeService();
    await knowledge.indexConfluencePage({
      id: "long-2",
      title: "Big How-To",
      body: longBody(),
      source: "confluence:long-2",
    });
    const first = knowledge.getChunkCountForSource("confluence:long-2");
    expect(first).toBeGreaterThan(1);

    // Re-sync the SAME source with a different long body.
    const sentences: string[] = [];
    for (let i = 0; i < 80; i++) {
      sentences.push(`Revised step ${i} of the workflow now reads differently here.`);
    }
    await knowledge.indexConfluencePage({
      id: "long-2",
      title: "Big How-To",
      body: sentences.join(" "),
      source: "confluence:long-2",
    });
    const second = knowledge.getChunkCountForSource("confluence:long-2");
    // Replaced, not accumulated — count reflects only the new body's passages.
    expect(second).toBeGreaterThan(1);
    expect(second).toBe(splitForCount(sentences.join(" ")));
    expect(knowledge.getStatus().documentCount).toBe(1);
  });

  it("a short page still produces >= 1 chunk", async () => {
    const knowledge = new KnowledgeService();
    await knowledge.indexConfluencePage({
      id: "short-1",
      title: "Tiny",
      body: "Short note.",
      source: "confluence:short-1",
    });
    expect(knowledge.getChunkCountForSource("confluence:short-1")).toBeGreaterThanOrEqual(1);
  });
});

// Local helper mirroring the chunker so the resync test asserts exact replacement.
function splitForCount(body: string): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { splitIntoPassages } = require("../src/ingestion/chunkText");
  return splitIntoPassages(body).length;
}

describe("config.yaml has a Confluence sync schedule", () => {
  it("contains a confluence section with a schedule/cron/interval field", () => {
    const configPath = path.join(__dirname, "..", "config.yaml");
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toMatch(/confluence/i);
    expect(content).toMatch(/schedule|cron|interval/i);
  });
});

describe("buildConfluenceFetcher (HTTP wiring)", () => {
  it("calls fetch with Basic auth and parses results into ConfluencePage[]", async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return {
          results: [
            {
              id: "abc",
              title: "Hello",
              body: { storage: { value: "<p>Hi <b>world</b></p>" } },
              space: { key: "DEMO" },
            },
          ],
        };
      },
    };
    const fetchImpl = jest.fn(async () => fakeResponse) as unknown as typeof fetch;
    const fetcher = buildConfluenceFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );
    const pages = await fetcher.fetchPages("DEMO");
    expect(pages).toHaveLength(1);
    expect(pages[0].id).toBe("abc");
    expect(pages[0].title).toBe("Hello");
    expect(pages[0].body).toContain("Hi");
    expect(pages[0].body).toContain("world");
    expect(pages[0].body).not.toContain("<");
    expect(pages[0].spaceKey).toBe("DEMO");
    expect(pages[0].source).toBe("confluence:abc");

    const callArgs = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    const url = callArgs[0] as string;
    const init = callArgs[1] as { headers: Record<string, string> };
    expect(url).toContain("/wiki/rest/api/content");
    expect(url).toContain("spaceKey=DEMO");
    expect(url).toContain("expand=body.storage");
    expect(init.headers.Authorization).toMatch(/^Basic /);
  });

  it("throws on non-2xx HTTP", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      async json() {
        return {};
      },
    })) as unknown as typeof fetch;
    const fetcher = buildConfluenceFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );
    await expect(fetcher.fetchPages("DEMO")).rejects.toThrow(/401/);
  });
});

describe("buildConfluenceFetcher pagination cursor (#1189)", () => {
  // Build a fake fetch Response whose json() yields the given results + optional
  // `_links.next` cursor. `results` are minimal synthetic Confluence page shapes.
  function makeResponse(results: Array<{ id: string }>, next?: string) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        const body: { results: unknown[]; _links?: { next: string } } = {
          results: results.map((r) => ({
            id: r.id,
            title: `Title ${r.id}`,
            body: { storage: { value: `<p>Body for ${r.id}</p>` } },
            space: { key: "DEMO" },
          })),
        };
        if (next !== undefined) body._links = { next };
        return body;
      },
    };
  }

  it("AC-3: follows _links.next across N=3 pages, restores /wiki prefix, stops on terminal page", async () => {
    // 3 chained pages. Pages 1 and 2 carry `_links.next` (page 1's omits the
    // `/wiki` context prefix — the exact real-API shape); the final page has no
    // next link (clean terminal). baseUrl WITHOUT a trailing slash.
    const responses = [
      // page 1 → next omits /wiki (must be restored)
      makeResponse([{ id: "p1" }], "/rest/api/content?spaceKey=DEMO&expand=body.storage&limit=100&start=100"),
      // page 2 → next already carries /wiki (must NOT be double-prefixed)
      makeResponse([{ id: "p2" }], "/wiki/rest/api/content?spaceKey=DEMO&expand=body.storage&limit=100&start=200"),
      // page 3 → no next link (terminal)
      makeResponse([{ id: "p3" }]),
    ];
    let call = 0;
    const fetchImpl = jest.fn(async () => responses[call++]) as unknown as typeof fetch;

    const fetcher = buildConfluenceFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );
    const pages = await fetcher.fetchPages("DEMO");

    // (a) all pages accumulated — one from every page in the chain
    expect(pages).toHaveLength(3);
    const ids = pages.map((p) => p.id).sort();
    expect(ids).toEqual(["p1", "p2", "p3"]);

    // (b) fetchImpl called EXACTLY N=3 times — walks every page, stops on the
    // terminal page (no over-/under-fetch).
    const mock = fetchImpl as unknown as jest.Mock;
    expect(mock).toHaveBeenCalledTimes(3);

    // (c) /wiki prefix restored on the cursor that omitted it. Call index 1 is
    // the follow-up driven by page 1's `_links.next` (which lacked /wiki).
    const followUpUrl = mock.mock.calls[1][0] as string;
    expect(followUpUrl).toContain("/wiki/rest/api/content");
    expect(followUpUrl).toContain("start=100");
    // Exactly ONE slash between host and /wiki (trailing-slash-trim join).
    expect(followUpUrl).toBe(
      "https://example.atlassian.net/wiki/rest/api/content?spaceKey=DEMO&expand=body.storage&limit=100&start=100",
    );
    // Page 2's cursor already had /wiki — confirm it was NOT double-prefixed.
    const thirdUrl = mock.mock.calls[2][0] as string;
    expect(thirdUrl).not.toContain("/wiki/wiki");
    expect(thirdUrl).toContain("/wiki/rest/api/content");
  });

  it("AC-3b: trailing-slash baseUrl does not double-slash the first or followed URL", async () => {
    const responses = [
      makeResponse([{ id: "p1" }], "/rest/api/content?spaceKey=DEMO&expand=body.storage&limit=100&start=100"),
      makeResponse([{ id: "p2" }]),
    ];
    let call = 0;
    const fetchImpl = jest.fn(async () => responses[call++]) as unknown as typeof fetch;
    const fetcher = buildConfluenceFetcher(
      { baseUrl: "https://example.atlassian.net/", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );
    await fetcher.fetchPages("DEMO");
    const mock = fetchImpl as unknown as jest.Mock;
    const firstUrl = mock.mock.calls[0][0] as string;
    const followUpUrl = mock.mock.calls[1][0] as string;
    expect(firstUrl).toBe(
      "https://example.atlassian.net/wiki/rest/api/content?spaceKey=DEMO&expand=body.storage&limit=100",
    );
    expect(followUpUrl).toBe(
      "https://example.atlassian.net/wiki/rest/api/content?spaceKey=DEMO&expand=body.storage&limit=100&start=100",
    );
  });

  it("AC-4: MAX_PAGES guard terminates a perpetual non-empty cursor at exactly MAX_PAGES", async () => {
    // Every response has NON-EMPTY results (so the empty-page guard cannot fire)
    // and ALWAYS carries a next link (cursor never terminates). Only MAX_PAGES
    // can stop the loop.
    let n = 0;
    const fetchImpl = jest.fn(async () => {
      n++;
      return makeResponse(
        [{ id: `page-${n}` }],
        `/rest/api/content?spaceKey=DEMO&expand=body.storage&limit=100&start=${n * 100}`,
      );
    }) as unknown as typeof fetch;

    const fetcher = buildConfluenceFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );
    const pages = await fetcher.fetchPages("DEMO");

    const mock = fetchImpl as unknown as jest.Mock;
    // Loops far past the single first fetch, and stops at EXACTLY the cap.
    expect(mock.mock.calls.length).toBeGreaterThan(1);
    expect(mock).toHaveBeenCalledTimes(MAX_PAGES);
    expect(MAX_PAGES).toBe(1000);
    // Completed (returned) rather than hung; accumulated one page per fetch.
    expect(pages).toHaveLength(MAX_PAGES);
  });

  it("AC-5: regression guard — empty page with a dangling cursor stops (does not spin)", async () => {
    // A page returns ZERO results but STILL hands back a `_links.next`. The loop
    // must stop on the empty-results guard rather than follow the dangling
    // cursor forever. (Regression guard — NOT counted as proof of the #1189 fix.)
    const fetchImpl = jest.fn(async () =>
      makeResponse([], "/rest/api/content?spaceKey=DEMO&expand=body.storage&limit=100&start=100"),
    ) as unknown as typeof fetch;

    const fetcher = buildConfluenceFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );
    const pages = await fetcher.fetchPages("DEMO");

    const mock = fetchImpl as unknown as jest.Mock;
    expect(mock).toHaveBeenCalledTimes(1);
    expect(pages).toHaveLength(0);
  });
});

describe("stripHtml entity coverage and ordering", () => {
  // stripHtml is module-private; we exercise it through buildConfluenceFetcher,
  // which runs the same path: HTML → ConfluencePage.body.
  async function fetchOne(htmlValue: string): Promise<string> {
    const fakeResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return {
          results: [
            {
              id: "id1",
              title: "T",
              body: { storage: { value: htmlValue } },
              space: { key: "S" },
            },
          ],
        };
      },
    };
    const fetchImpl = jest.fn(async () => fakeResponse) as unknown as typeof fetch;
    const fetcher = buildConfluenceFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );
    const pages = await fetcher.fetchPages("S");
    return pages[0].body;
  }

  it("decodes numeric HTML entities (e.g. &#8217; smart apostrophe)", async () => {
    // U+2019 RIGHT SINGLE QUOTATION MARK = decimal 8217
    const body = await fetchOne("<p>it&#8217;s here</p>");
    expect(body).toContain("it’s here");
    expect(body).not.toContain("&#8217;");
  });

  it("decodes multiple numeric entities in one document", async () => {
    // 8212 = em dash (—), 8230 = horizontal ellipsis (…)
    const body = await fetchOne("<p>hello&#8212;world&#8230;</p>");
    expect(body).toContain("hello—world…");
    expect(body).not.toMatch(/&#\d+;/);
  });

  it("strips tags BEFORE decoding entities (ordering: encoded <script> in text stays inert)", async () => {
    // The text content contains an encoded <script> payload. If entity-decode
    // ran first, the literal "<script>alert(1)</script>" would materialize and
    // then be tag-stripped — but the decode-then-strip ordering is fragile
    // because it requires a second tag-strip pass. The current
    // strip-then-decode ordering keeps the payload as inert text "<script>"
    // (angle brackets only) without the <script> tag ever existing as markup.
    const body = await fetchOne("<p>safe &lt;script&gt;alert(1)&lt;/script&gt; tail</p>");
    // After stripping tags first, &lt; / &gt; decode to literal < / >, so
    // the payload appears as plain text — never as a real tag.
    expect(body).toContain("<script>alert(1)</script>");
    expect(body).toContain("safe");
    expect(body).toContain("tail");
    // And the surrounding <p> tag is gone.
    expect(body).not.toMatch(/<p>/);
  });

  it("decodes named entities alongside numeric ones", async () => {
    const body = await fetchOne("<p>A &amp; B &#38; C</p>");
    // &amp; → &, &#38; → & (also ampersand)
    expect(body).toBe("A & B & C");
  });
});
