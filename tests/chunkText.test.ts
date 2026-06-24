import { splitIntoPassages } from "../src/ingestion/chunkText";

const MAX = 900; // DEFAULT_MAX_CHARS

describe("splitIntoPassages (AC2 — pure chunker)", () => {
  it("empty / whitespace-only input -> []", () => {
    expect(splitIntoPassages("")).toEqual([]);
    expect(splitIntoPassages("   \n\t  ")).toEqual([]);
    expect(splitIntoPassages(undefined as unknown as string)).toEqual([]);
  });

  it("a 7-char non-empty body -> exactly 1 passage (correction #1: minChars never zeroes a non-empty body)", () => {
    const out = splitIntoPassages("v1 body");
    expect(out).toEqual(["v1 body"]);
    expect(out).toHaveLength(1);
  });

  it("a 12-char non-empty body -> exactly 1 passage (the other short-fixture used in confluence tests)", () => {
    expect(splitIntoPassages("real content")).toEqual(["real content"]);
  });

  it("a 5000-char single-line input -> multiple passages, each <= maxChars", () => {
    // Build ~120 short sentences on a single line (no newlines). ~5000 chars.
    const sentences: string[] = [];
    for (let i = 0; i < 120; i++) {
      sentences.push(`Sentence number ${i} carries some filler words for packing.`);
    }
    const text = sentences.join(" ");
    expect(text.length).toBeGreaterThan(5000);
    expect(text.includes("\n")).toBe(false);

    const passages = splitIntoPassages(text);
    expect(passages.length).toBeGreaterThan(1);
    for (const p of passages) {
      expect(p.length).toBeLessThanOrEqual(MAX);
      expect(p.length).toBeGreaterThan(0);
    }
  });

  it("overlap is present between consecutive passages (the next passage starts with a tail of the prior)", () => {
    const sentences: string[] = [];
    for (let i = 0; i < 120; i++) {
      sentences.push(`Sentence number ${i} carries some filler words for packing.`);
    }
    const passages = splitIntoPassages(sentences.join(" "));
    expect(passages.length).toBeGreaterThan(1);

    // Each passage (after the first) begins with an overlap tail taken from the
    // END of the previous passage, so its first 30 chars are a substring of the
    // previous passage.
    for (let i = 1; i < passages.length; i++) {
      const head = passages[i].slice(0, 30);
      expect(head.length).toBe(30);
      expect(passages[i - 1].includes(head)).toBe(true);
    }
  });

  it("a sub-minChars trailing fragment is dropped when >= 2 passages exist", () => {
    // First sentence near maxChars, then a tiny 'Zz.' sentence. Disable overlap so
    // the tiny final sentence stands alone as a < minChars passage and is dropped.
    const longSentence = "x".repeat(898) + ".";
    const text = `${longSentence} Zz.`;
    const passages = splitIntoPassages(text, { overlapChars: 0, minChars: 20 });
    expect(passages).toHaveLength(1); // the tiny 'Zz.' tail was dropped
    expect(passages.some((p) => p.includes("Zz"))).toBe(false);
    expect(passages[0].length).toBeLessThanOrEqual(MAX);
  });

  it("a single sentence longer than maxChars -> hard-split into bounded passages with overlap", () => {
    // 2500-char run-on with NO sentence terminator -> hard char-window split.
    const longSentence = "abcdefghij".repeat(250); // 2500 chars, no . ! ?
    expect(longSentence.length).toBe(2500);
    const passages = splitIntoPassages(longSentence);

    expect(passages.length).toBeGreaterThan(1);
    for (const p of passages) {
      expect(p.length).toBeLessThanOrEqual(MAX);
    }
    // Overlap present: consecutive windows share a boundary region.
    for (let i = 1; i < passages.length; i++) {
      const head = passages[i].slice(0, 30);
      expect(passages[i - 1].includes(head)).toBe(true);
    }
  });

  it("never zeroes out a non-empty body even when every fragment is below minChars", () => {
    // A short single sentence below a large minChars must still survive.
    expect(splitIntoPassages("tiny.", { minChars: 1000 })).toEqual(["tiny."]);
  });
});
