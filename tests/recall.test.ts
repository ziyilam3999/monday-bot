import { embed } from "../src/embeddings/embed";
import { VectorIndex } from "../src/index/vectorIndex";
import { splitIntoPassages } from "../src/ingestion/chunkText";

/**
 * AC3 — recall both-ends proof (#1189), dilution mechanism.
 *
 * IMPORTANT — which embedder runs here: jest remaps `@xenova/transformers` to a
 * deterministic bag-of-words stub (tests/__stubs__/xenova-transformers.js — a
 * normalized token histogram). That stub reproduces the PRIMARY #1189 failure,
 * AVERAGING-DILUTION: a whole-doc vector spreads the answer's keywords across
 * thousands of tokens so its query-similarity collapses toward zero. Splitting
 * into passages embeds the answer's region with far less filler around it, so the
 * best answer-bearing chunk's similarity is many times higher than the whole-doc
 * vector's — that lift is exactly what lets the relevant passage climb into
 * top-K in production.
 *
 * What the stub canNOT host: the absolute "chunk ranks within topK against
 * keyword decoys" claim. In pure bag-of-words a 900-char production chunk is
 * still mostly filler, so it can't out-score an ultra-dense keyword decoy the way
 * the REAL semantic MiniLM model does (the real model embeds the answer region's
 * MEANING, not its token frequencies). The real-embedder topK both-ends
 * (RED: buried past topK=12 / GREEN: within topK=12, answer pinned past 2000
 * chars) is proven by the standalone script run outside jest + the live
 * re-measure — see the executor report. This spec proves the deterministic
 * mechanism the production fix rests on.
 *
 * RED end: the whole-doc vector is buried below keyword decoys (low similarity).
 * GREEN end: chunking lifts the answer region's similarity far above the diluted
 * whole-doc vector — dilution removed.
 */

const QUERY = "alpha beta gamma delta epsilon rotation procedure";
const ANSWER_SENTENCE =
  "The alpha beta gamma delta epsilon rotation procedure must be run from the admin console.";
const ANSWER_SOURCE = "confluence:answer-doc";

function filler(i: number): string {
  return `Background note ${i} about meetings schedules lunches parking and weather updates.`;
}

/** Long prose doc with the answer sentence pinned in the MIDDLE, past ~2000 chars. */
function buildLongDoc(): string {
  const parts: string[] = [];
  for (let i = 0; i < 60; i++) parts.push(filler(i));
  parts.push(ANSWER_SENTENCE);
  for (let i = 60; i < 120; i++) parts.push(filler(i));
  return parts.join(" ");
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

describe("AC3 recall both-ends — dilution mechanism (#1189)", () => {
  jest.setTimeout(30_000);

  const longDoc = buildLongDoc();

  it("fixture: the answer sits past the first ~2000 chars (correction #3)", () => {
    expect(longDoc.indexOf(ANSWER_SENTENCE)).toBeGreaterThan(2000);
  });

  it("RED: the whole-doc vector is buried below keyword decoys for the answer query", async () => {
    const index = new VectorIndex();
    // Keyword decoys that share query tokens — these out-rank the diluted whole doc.
    const decoys = [
      "alpha beta", "gamma delta", "delta epsilon", "alpha gamma", "beta delta",
      "gamma epsilon", "alpha delta", "beta gamma", "alpha epsilon", "beta epsilon",
      "gamma alpha", "delta beta", "epsilon gamma", "delta alpha", "epsilon beta",
    ].map((p, i) => ({ text: `${p} ${p} ${p}`, source: `confluence:decoy-${i}` }));

    await index.add(decoys);
    await index.add([{ text: longDoc, source: ANSWER_SOURCE }]); // ONE diluted vector

    const results = await index.search(QUERY, decoys.length + 1);
    const rank = results.findIndex((r) => r.source === ANSWER_SOURCE) + 1;
    // Buried: the whole-doc vector ranks behind every keyword decoy.
    expect(rank).toBeGreaterThan(12);
  });

  it("GREEN: chunking lifts the answer region's similarity far above the diluted whole-doc vector", async () => {
    const q = await embed(QUERY);
    const wholeDocSim = cosine(q, await embed(longDoc));

    const passages = splitIntoPassages(longDoc);
    expect(passages.length).toBeGreaterThan(1);

    let bestChunkSim = -Infinity;
    for (const p of passages) {
      bestChunkSim = Math.max(bestChunkSim, cosine(q, await embed(p)));
    }

    // Dilution removed: the best answer-bearing chunk is many times more similar
    // to the query than the whole-doc average. This concentration is what carries
    // the passage into top-K under the real semantic embedder.
    expect(bestChunkSim).toBeGreaterThan(wholeDocSim * 3);
  });
});
