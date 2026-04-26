import * as fs from "node:fs";
import * as path from "node:path";

import {
  ConfluenceSync,
  ConfluenceFetcher,
  ConfluencePage,
  buildConfluenceFetcher,
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
