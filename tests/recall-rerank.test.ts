import { rerank } from "../src/knowledge/rerank";

/**
 * A1 — Lever 2 (rerank) logic units (#1191). Uses an INJECTED deterministic
 * scorer — NO real cross-encoder model is loaded (correction #4). RED today:
 * function absent.
 */

interface Cand {
  text: string;
  id: string;
}

describe("rerank (Lever 2)", () => {
  it("AC3: reorders candidates by descending injected score", async () => {
    const candidates: Cand[] = [
      { text: "a", id: "a" },
      { text: "b", id: "b" },
      { text: "c", id: "c" },
    ];
    const scores: Record<string, number> = { a: 1, b: 3, c: 2 };
    const out = await rerank("q", candidates, {
      enabled: true,
      scoreFn: (_q, text) => scores[text],
    });
    expect(out.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("scores the ORIGINAL question, not an expanded one", async () => {
    let seenQuestion = "";
    await rerank("original question", [{ text: "x", id: "x" }], {
      enabled: true,
      scoreFn: (q) => {
        seenQuestion = q;
        return 1;
      },
    });
    expect(seenQuestion).toBe("original question");
  });

  it("disabled rerank is an identity (returns candidates unchanged)", async () => {
    const candidates: Cand[] = [
      { text: "a", id: "a" },
      { text: "b", id: "b" },
    ];
    const out = await rerank("q", candidates, { enabled: false, scoreFn: () => Math.random() });
    expect(out).toEqual(candidates);
  });

  it("is stable on tied scores (preserves original order)", async () => {
    const candidates: Cand[] = [
      { text: "a", id: "a" },
      { text: "b", id: "b" },
      { text: "c", id: "c" },
    ];
    const out = await rerank("q", candidates, { enabled: true, scoreFn: () => 5 });
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("supports async scorers", async () => {
    const candidates: Cand[] = [
      { text: "lo", id: "lo" },
      { text: "hi", id: "hi" },
    ];
    const out = await rerank("q", candidates, {
      enabled: true,
      scoreFn: async (_q, t) => (t === "hi" ? 10 : 1),
    });
    expect(out.map((c) => c.id)).toEqual(["hi", "lo"]);
  });
});
