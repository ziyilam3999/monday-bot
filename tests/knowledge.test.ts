import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { KnowledgeService } from "../src/knowledge/service";
import { VectorIndex } from "../src/index/vectorIndex";
import { Chunk as LlmChunk, Citation } from "../src/llm/generate";

jest.setTimeout(60_000);

const tmpDirs: string[] = [];

function mkTempFile(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-svc-test-"));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("KnowledgeService", () => {
  describe("query without indexed documents", () => {
    it("returns the no-documents answer with empty citations", async () => {
      const svc = new KnowledgeService();
      const result = await svc.query("what is the firewall policy?");
      expect(typeof result.answer).toBe("string");
      expect(result.answer.toLowerCase()).toMatch(/find|index/);
      expect(Array.isArray(result.citations)).toBe(true);
      expect(result.citations).toEqual([]);
    });

    it("does not call the generator when index is empty", async () => {
      const generator = jest.fn();
      const svc = new KnowledgeService({ generator });
      await svc.query("anything");
      expect(generator).not.toHaveBeenCalled();
    });
  });

  describe("indexFile + query end-to-end", () => {
    it("indexes a real file then routes search hits into the generator", async () => {
      const file = mkTempFile(
        "firewall.txt",
        "The firewall policy blocks port 80 entirely. Port 443 is logged.",
      );

      const generator = jest.fn(async (_q: string, chunks: LlmChunk[]) => {
        const citations: Citation[] = chunks.map((c, i) => {
          const entry: Citation = { number: i + 1, source: c.source };
          if (c.heading) entry.heading = c.heading;
          return entry;
        });
        return {
          answer: `Port 80 is blocked entirely [1].`,
          citations,
        };
      });

      const svc = new KnowledgeService({ generator });
      await svc.indexFile(file);
      const result = await svc.query("what ports does the firewall block?");

      expect(result.answer).toContain("80");
      expect(result.citations.length).toBeGreaterThan(0);
      expect(result.citations[0]).toMatchObject({ number: 1 });
      expect(generator).toHaveBeenCalledTimes(1);

      const passedChunks = generator.mock.calls[0][1];
      expect(Array.isArray(passedChunks)).toBe(true);
      expect(passedChunks.length).toBeGreaterThan(0);
      expect(typeof passedChunks[0].text).toBe("string");
      expect(typeof passedChunks[0].source).toBe("string");
    });

    it("indexFile is a no-op when ingest returns no chunks", async () => {
      const ingest = jest.fn(async () => []);
      const svc = new KnowledgeService({ ingest });
      await svc.indexFile("/some/empty/file.txt");
      expect(svc.getStatus().documentCount).toBe(0);
    });

    it("rejects empty paths", async () => {
      const svc = new KnowledgeService();
      await expect(svc.indexFile("")).rejects.toThrow(TypeError);
    });
  });

  describe("getStatus", () => {
    it("returns the documented shape with correct types", () => {
      const svc = new KnowledgeService();
      const status = svc.getStatus();
      expect(typeof status.documentCount).toBe("number");
      expect(typeof status.uptimeSeconds).toBe("number");
      expect(status.documentCount).toBe(0);
      expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it("counts unique source files, not individual chunks", async () => {
      const ingest = jest.fn(async (p: string) => [
        { text: "chunk a", source: p },
        { text: "chunk b", source: p },
      ]);
      const svc = new KnowledgeService({ ingest });
      await svc.indexFile("/fake/path/one.txt");
      await svc.indexFile("/fake/path/two.txt");
      expect(svc.getStatus().documentCount).toBe(2);
    });

    it("reports uptimeSeconds based on injected clock", () => {
      let t = 1_000_000;
      const svc = new KnowledgeService({ now: () => t });
      t += 7_500;
      expect(svc.getStatus().uptimeSeconds).toBe(7);
    });
  });

  describe("query type guards", () => {
    it("throws on non-string question", async () => {
      const svc = new KnowledgeService();
      await expect(
        svc.query(undefined as unknown as string),
      ).rejects.toThrow(TypeError);
    });

    it.each(["", "   ", "\n\t "])(
      "rejects blank question %j on an empty index without calling the generator",
      async (blank) => {
        const generator = jest.fn();
        const svc = new KnowledgeService({ generator });
        const p = svc.query(blank);
        await expect(p).rejects.toThrow(TypeError);
        await expect(p).rejects.toThrow("KnowledgeService.query");
        expect(generator).not.toHaveBeenCalled();
      },
    );

    it.each(["", "   ", "\n\t "])(
      "rejects blank question %j on a non-empty index without calling the generator",
      async (blank) => {
        const generator = jest.fn();
        const svc = new KnowledgeService({ generator });
        await svc.indexChunks([{ text: "The firewall blocks port 80.", source: "s1" }]);
        const p = svc.query(blank);
        await expect(p).rejects.toThrow(TypeError);
        await expect(p).rejects.toThrow("KnowledgeService.query");
        expect(generator).not.toHaveBeenCalled();
      },
    );
  });

  describe("indexChunks { replace: true } (#151)", () => {
    it("a replace batch under the same source replaces the prior chunks", async () => {
      const index = new VectorIndex();
      const svc = new KnowledgeService({ index });
      await svc.indexChunks([
        { text: "first passage of doc one", source: "s1" },
        { text: "second passage of doc one", source: "s1" },
      ]);
      expect(index.size()).toBe(2);

      await svc.indexChunks([{ text: "rewritten passage of doc one", source: "s1" }], {
        replace: true,
      });

      expect(index.size()).toBe(1);
      expect(svc.getStatus().documentCount).toBe(1);
      expect(svc.getChunkCountForSource("s1")).toBe(1);
    });

    it("without the option, batches append (the default is unchanged)", async () => {
      const index = new VectorIndex();
      const svc = new KnowledgeService({ index });
      await svc.indexChunks([
        { text: "first passage of doc one", source: "s1" },
        { text: "second passage of doc one", source: "s1" },
      ]);
      await svc.indexChunks([{ text: "rewritten passage of doc one", source: "s1" }]);

      expect(index.size()).toBe(3);
      expect(svc.getStatus().documentCount).toBe(1);
    });

    it("replace removes only the sources named in the new batch", async () => {
      const index = new VectorIndex();
      const svc = new KnowledgeService({ index });
      await svc.indexChunks([
        { text: "first passage of doc one", source: "s1" },
        { text: "second passage of doc one", source: "s1" },
      ]);
      await svc.indexChunks([{ text: "the only passage of doc two", source: "s2" }]);

      await svc.indexChunks([{ text: "rewritten passage of doc one", source: "s1" }], {
        replace: true,
      });

      // s1's two old chunks are gone (one new chunk in their place); s2's
      // chunk survives untouched.
      expect(index.size()).toBe(2);
      expect(svc.getChunkCountForSource("s1")).toBe(1);
      expect(svc.getChunkCountForSource("s2")).toBe(1);
      expect(svc.getStatus().documentCount).toBe(2);
    });

    it.each([
      ["an empty-string source", { text: "bad chunk", source: "" }],
      ["a missing source", { text: "bad chunk" }],
    ])("a replace batch with %s rejects and leaves the index untouched", async (_name, bad) => {
      const index = new VectorIndex();
      const svc = new KnowledgeService({ index });
      await svc.indexChunks([
        { text: "first passage of doc one", source: "s1" },
        { text: "second passage of doc one", source: "s1" },
      ]);
      const before = index.size();

      await expect(
        svc.indexChunks(
          [{ text: "rewritten passage of doc one", source: "s1" }, bad as never],
          { replace: true },
        ),
      ).rejects.toThrow(TypeError);

      expect(index.size()).toBe(before);
      expect(svc.getChunkCountForSource("s1")).toBe(2);
      expect(svc.getStatus().documentCount).toBe(1);
    });

    it("rejects a non-boolean replace option", async () => {
      const svc = new KnowledgeService();
      await expect(
        svc.indexChunks([{ text: "a passage", source: "s1" }], {
          replace: "yes" as unknown as boolean,
        }),
      ).rejects.toThrow(TypeError);
    });
  });
});
