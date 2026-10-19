/**
 * 3286 Part A — sync-responsive smoke suite (jest).
 *
 * Scope here is COPY + MECHANISM only: the warming-up / sync-failed answers
 * (AC-3) and the R1 cooperative-yield regression. The responsiveness BOUNDS
 * (AC-2/AC-4/AC-5) deliberately do NOT live in this file: jest's
 * moduleNameMapper replaces the embedder with a stub that cannot block, so a
 * jest-measured loop/handler bound is vacuous by construction — those bounds
 * run in scripts/sync-responsive-smoke.js (plain node, real backend).
 */

import { KnowledgeService } from "../src/knowledge/service";
import { VectorIndex } from "../src/index/vectorIndex";
import { startKnowledgeSources } from "../src/knowledge/startup";
import { ConfluenceFetcher } from "../src/confluence/sync";

const COULDNT_FIND = "couldn't find any relevant information";

function stubGenerator(question: string): Promise<{ answer: string; citations: never[] }> {
  return Promise.resolve({ answer: `stub answer: ${question}`, citations: [] });
}

/** Fetcher stub that rejects: drives the sync-failed copy via the production wiring. */
function rejectingFetcher(): ConfluenceFetcher {
  return {
    async fetchPages(): Promise<never[]> {
      throw new Error("fixture fetcher failure");
    },
  };
}

describe("sync responsive (3286 Part A)", () => {
  it("warming up: empty index + initial sync in flight → still-warming-up copy, never the couldn't-find copy", async () => {
    const knowledge = new KnowledgeService({ generator: stubGenerator });
    expect(knowledge.getInitialSyncPhase()).toBe("not-started");

    knowledge.noteInitialSyncStarted();
    expect(knowledge.getInitialSyncPhase()).toBe("in-flight");

    const res = await knowledge.query("how do I request a refund approval?");
    expect(res.answer).toMatch(/warming up/);
    expect(res.answer).not.toContain(COULDNT_FIND);
    expect(res.citations).toEqual([]);
  });

  it("warming up: documents indexed mid-sync → normal answer (partial beats refusal)", async () => {
    const knowledge = new KnowledgeService({ generator: stubGenerator });
    knowledge.noteInitialSyncStarted();

    await knowledge.indexChunks([{ text: "refund approvals go through the payments team", source: "confluence:p1" }]);
    const res = await knowledge.query("how do I request a refund approval?");

    expect(res.answer).toBe("stub answer: how do I request a refund approval?");
  });

  it("warming up: no sources configured at all → the old couldn't-find copy is retained", async () => {
    const knowledge = new KnowledgeService({ generator: stubGenerator });

    const res = await knowledge.query("how do I request a refund approval?");

    expect(res.answer).toContain(COULDNT_FIND);
    expect(res.answer).not.toMatch(/warming up/);
  });

  it("warming up: every initial-sync fetcher rejected → distinct sync-failed copy, never the couldn't-find copy", async () => {
    const knowledge = new KnowledgeService({ generator: stubGenerator });
    const sources = startKnowledgeSources({
      knowledge,
      env: {
        CONFLUENCE_URL: "https://fixture.example.invalid/wiki",
        CONFLUENCE_EMAIL: "fixtures@example.invalid",
        CONFLUENCE_API_TOKEN: "fixture-placeholder-not-a-credential",
        CONFLUENCE_SPACES: "DEMO",
      },
      confluenceFetcher: rejectingFetcher(),
      scheduler: () => ({ clear: () => undefined }),
      logger: { info: () => undefined, error: () => undefined },
    });

    await sources.ready; // never rejects; every initial sync settled (failed)
    expect(knowledge.getInitialSyncPhase()).toBe("failed");

    const res = await knowledge.query("how do I request a refund approval?");
    expect(res.answer).not.toContain(COULDNT_FIND);
    expect(res.answer).not.toMatch(/warming up/);
    expect(res.answer.length).toBeGreaterThan(0);
    expect(res.citations).toEqual([]);
  });

  it("R1 cooperative yield: a pending setImmediate callback runs before a multi-chunk add() resolves", async () => {
    // Regression for the measured defect: an await-chained embed loop never
    // reached the timers phase, starving every due timer in the process for
    // the whole sync. With the per-passage setImmediate yield, loop work
    // scheduled alongside indexing interleaves with it.
    const index = new VectorIndex();
    const ran: string[] = [];

    const adding = index.add([
      { text: "alpha passage about deployment windows", source: "confluence:p1" },
      { text: "beta passage about incident escalation", source: "confluence:p2" },
    ]);
    setImmediate(() => ran.push("immediate"));

    await adding;

    expect(index.size()).toBe(2);
    expect(ran).toContain("immediate");
  });
});
