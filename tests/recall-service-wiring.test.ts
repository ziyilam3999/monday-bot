import { KnowledgeService } from "../src/knowledge/service";
import { VectorIndex } from "../src/index/vectorIndex";

/**
 * A1 — service-wiring proof (#1191, correction #1): the recall levers actually
 * RUN inside KnowledgeService.retrieve(), and the SHIPPED DEFAULTS (no `recall`
 * opts → expansion ON, diversity cap ON, rerank OFF) are LIVE-by-default. Uses
 * the jest stub embedder (deterministic bag-of-words), so ranking shifts are
 * driven purely by token overlap — which makes expansion's effect observable.
 */

async function buildIndex(docs: Array<{ source: string; text: string }>): Promise<VectorIndex> {
  const index = new VectorIndex();
  await index.add(docs.map((d) => ({ text: d.text, source: d.source })));
  return index;
}

describe("KnowledgeService recall wiring (correction #1: live-by-default)", () => {
  it("expansion is ON by default and changes ranking for a geo query", async () => {
    // syn doc speaks ONLY launch/market vocabulary (no question words).
    // word doc speaks the question's literal words.
    const docs = [
      { source: "confluence:syn", text: "markets regions coverage launch expansion" },
      { source: "confluence:word", text: "places service available here today" },
    ];

    const question = "which places have the service available";

    // Default service (NO recall opts) → expansion ON. The syn doc, invisible to
    // the raw question, surfaces to rank 1 once the geo synonyms are appended.
    const onDefault = new KnowledgeService({ index: await buildIndex(docs) });
    const onHits = await onDefault.retrieve(question);
    expect(onHits[0].source).toBe("confluence:syn");
    expect(onHits[0].score).toBeGreaterThan(0);

    // Expansion explicitly OFF → the syn doc shares NO tokens with the raw
    // question (score 0); the literal-word doc ranks first instead.
    const off = new KnowledgeService({
      index: await buildIndex(docs),
      recall: { queryExpansion: { enabled: false }, diversityCap: { enabled: false } },
    });
    const offHits = await off.retrieve(question);
    expect(offHits[0].source).toBe("confluence:word");
    const syn = offHits.find((h) => h.source === "confluence:syn");
    expect(syn?.score ?? 0).toBe(0);
  });

  it("diversity cap is ON by default and bounds a monopolizing source-type in topK", async () => {
    // 10 jira + 6 confluence, all sharing the query token → equal scores. With
    // the default cap (6/type) the jira swarm can't take more than 6 of top-12.
    const docs = [
      ...Array.from({ length: 10 }, (_, i) => ({ source: `jira:T-${i}`, text: "alpha alpha" })),
      ...Array.from({ length: 6 }, (_, i) => ({ source: `confluence:C-${i}`, text: "alpha alpha" })),
    ];
    const svc = new KnowledgeService({ index: await buildIndex(docs), topK: 12 });
    const hits = await svc.retrieve("alpha");
    const jira = hits.filter((h) => h.source.startsWith("jira:")).length;
    expect(jira).toBeLessThanOrEqual(6);
    expect(hits.length).toBe(12);
  });

  it("rerank is OFF by default; enabling it with an injected scorer reorders results", async () => {
    // Distinct texts (each shares the query token so all are retrieved), so an
    // injected scorer can discriminate by candidate text.
    const docs = [
      { source: "jira:A", text: "alpha one" },
      { source: "jira:B", text: "alpha two" },
      { source: "jira:C", text: "alpha three" },
    ];

    // Default (rerank OFF): equal cosine → stable insertion order A, B, C.
    const defaultSvc = new KnowledgeService({
      index: await buildIndex(docs),
      topK: 12,
      recall: { diversityCap: { enabled: false } },
    });
    const defaultHits = await defaultSvc.retrieve("alpha");
    expect(defaultHits.map((h) => h.source)).toEqual(["jira:A", "jira:B", "jira:C"]);

    // rerank ON via injected scorer keyed on text: "three" > "two" > "one".
    const weight: Record<string, number> = { "alpha three": 9, "alpha two": 5, "alpha one": 1 };
    const reranked = new KnowledgeService({
      index: await buildIndex(docs),
      topK: 12,
      recall: {
        diversityCap: { enabled: false },
        rerank: { enabled: true, scoreFn: (_q: string, text: string) => weight[text] ?? 0 },
      },
    });
    const reHits = await reranked.retrieve("alpha");
    expect(reHits.map((h) => h.source)).toEqual(["jira:C", "jira:B", "jira:A"]);
  });

  it("levers fully OFF → retrieve() is byte-identical to a raw search(topK)", async () => {
    const docs = [
      { source: "confluence:a", text: "alpha beta" },
      { source: "jira:b", text: "beta gamma" },
      { source: "confluence:c", text: "alpha gamma" },
    ];
    const index = await buildIndex(docs);
    const off = new KnowledgeService({
      index,
      topK: 12,
      recall: {
        queryExpansion: { enabled: false },
        diversityCap: { enabled: false },
        rerank: { enabled: false },
      },
    });
    const hits = await off.retrieve("alpha beta gamma");
    const raw = await index.search("alpha beta gamma", 12);
    expect(hits.map((h) => h.id)).toEqual(raw.map((r) => r.id));
  });
});
