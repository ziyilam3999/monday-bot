import { readFileSync } from "fs";
import { join } from "path";
import { stripNameCall } from "../src/llm/generate";
import { BOT_NAME_TOKENS } from "../src/telegram/helpGate";

/**
 * #3323 — pure-function suite for the name-call cleaner. The cleaner is
 * keep-by-default: every input in `keep` must come back byte-identical, every
 * `fire` entry must produce its exact output. Both live in ONE data file so
 * the corpus is the single record. Zero network, no model client.
 */
const corpus: { keep: string[]; fire: Array<{ in: string; out: string }> } = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "3323-vocative-corpus.json"), "utf8"),
);

/** True when `out` can be obtained from `inp` by deleting characters only. */
function isSubsequence(out: string, inp: string): boolean {
  let j = 0;
  for (let i = 0; i < inp.length && j < out.length; i += 1) {
    if (inp[i] === out[j]) j += 1;
  }
  return j === out.length;
}

describe("corpus file", () => {
  it("has non-empty keep and fire arrays", () => {
    expect(corpus.keep.length).toBeGreaterThan(0);
    expect(corpus.fire.length).toBeGreaterThan(0);
  });
  it("carries at least 12 invented-word anti-denylist entries", () => {
    const invented = corpus.keep.filter((s) => /^(hi |hey |hello )?Monday, [a-z]+ /.test(s));
    expect(invented.length).toBeGreaterThanOrEqual(12);
  });
});

describe("stripNameCall — keep set is byte-identical", () => {
  for (const input of corpus.keep) {
    it(`keeps ${JSON.stringify(input)}`, () => {
      expect(stripNameCall(input)).toBe(input);
    });
  }
});

describe("stripNameCall — fire set produces the exact output", () => {
  for (const { in: input, out } of corpus.fire) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(out)}`, () => {
      expect(stripNameCall(input)).toBe(out);
    });
  }
});

describe("stripNameCall — properties", () => {
  it("every fire output is a deletion-only, non-empty result", () => {
    for (const { in: input, out } of corpus.fire) {
      expect(out.length).toBeGreaterThan(0);
      expect(isSubsequence(out, input)).toBe(true);
    }
  });

  it("single source of truth: every BOT_NAME_TOKENS entry fires on '<token>, can you help?'", () => {
    for (const token of BOT_NAME_TOKENS) {
      expect(stripNameCall(`${token}, can you help?`)).toBe("can you help?");
    }
  });

  it("arm A salutation is limited to salutations (time-of-day words never arm it)", () => {
    for (const w of ["good", "morning", "afternoon", "evening"]) {
      const input = `${w} Monday, can you cover the shift?`;
      expect(stripNameCall(input)).toBe(input);
    }
    expect(stripNameCall("hey Monday, can you cover the shift?")).toBe("hey, can you cover the shift?");
  });

  it("named risk 3323-please-opener-date: a memo 'please' opener keeps its weekday", () => {
    const input = "Monday, please submit timesheets - is that the rule?";
    expect(stripNameCall(input)).toBe(input);
  });

  it("fails closed past the 4096-character bound, cleans at the bound", () => {
    const pad = "x".repeat(4096 - "Monday, can you help? ".length);
    const atBound = `Monday, can you help? ${pad}`;
    expect(atBound.length).toBe(4096);
    expect(stripNameCall(atBound)).toBe(atBound.slice("Monday, ".length));
    const over = `${atBound}y`;
    expect(over.length).toBe(4097);
    expect(stripNameCall(over)).toBe(over);
  });

  it("is total on degenerate input", () => {
    for (const s of ["", " ", "\n", ",", "@", "@monday_bot", "monday-bot,"]) {
      expect(typeof stripNameCall(s)).toBe("string");
    }
  });
});

describe("cleaner source holds no date vocabulary", () => {
  const src = readFileSync(join(__dirname, "..", "src", "llm", "generate.ts"), "utf8");
  it("stripNameCall body contains none of the date-word markers", () => {
    const body = stripNameCall.toString().toLowerCase();
    for (const w of ["sept", "tomorrow", "midnight", "ordinal", "tue", "jan"]) {
      expect(body).not.toContain(w);
    }
  });
  it("the old date sets and guard are gone from generate.ts", () => {
    for (const sym of [
      "isDatePhraseWord",
      "WEEKDAY_WORDS",
      "MONTH_WORDS",
      "ORDINAL_WORDS",
      "DATE_ABBREV_WORDS",
      "DATE_TIME_WORDS",
    ]) {
      expect(src).not.toContain(sym);
    }
  });
  it("no second name list: the quoted token literal is absent; helper is called exactly once", () => {
    expect(src.split('"monday-bot"').length - 1).toBe(0);
    const calls = src.split("\n").filter((l) => /stripNameCall\(/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l) && !/export function/.test(l));
    expect(calls).toHaveLength(1);
  });
});
