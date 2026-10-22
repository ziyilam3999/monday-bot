import { stripNameCall } from "../src/llm/generate";
import { BOT_NAME_TOKENS } from "../src/telegram/helpGate";

/**
 * #3323 — pure-function tables for the name-call cleaner (the bot knows its
 * own name, so "Monday, ..." is a vocative, not a weekday). Zero network, zero
 * fixtures, no model client: stripNameCall is a pure exported string → string.
 *
 * Property arms: byte-identity on every must-not-fire input (the #3299 parity
 * convention), single-source coverage driven by BOT_NAME_TOKENS itself (AC-8
 * by construction — a future token added to the constant is covered with no
 * test edit), and the compose arm (arms are independent).
 */

describe("stripNameCall — leading name-call", () => {
  const cases: Array<[string, string]> = [
    [
      "Monday, can provide business rules for dispute resolution?",
      "can provide business rules for dispute resolution?",
    ],
    ["MONDAY, what about the refund policy?", "what about the refund policy?"],
    // A standalone comma token announces the name just as well.
    ["Monday , what about the refund policy?", "what about the refund policy?"],
  ];
  for (const [input, expected] of cases) {
    it(`strips the leading name-call from "${input}"`, () => {
      expect(stripNameCall(input)).toBe(expected);
    });
  }

  const kept = [
    // No announcing comma → genuinely ambiguous → kept (named-risk arm).
    "Monday what was deployed",
    "the Monday deploy checklist",
  ];
  for (const input of kept) {
    it(`keeps "${input}" byte-identical`, () => {
      expect(stripNameCall(input)).toBe(input);
    });
  }
});

describe("stripNameCall — greeting-adjacent name-call", () => {
  it("strips the name, keeps the greeting and its announcing comma", () => {
    expect(stripNameCall("hey Monday, can you summarise the refund policy?")).toBe(
      "hey, can you summarise the refund policy?",
    );
  });

  it("strips the name with no comma to park", () => {
    expect(stripNameCall("hi monday-bot what about annual leave")).toBe(
      "hi what about annual leave",
    );
  });

  it("strips the name from an all-caps greeting pair", () => {
    expect(stripNameCall("HELLO MONDAY what about annual leave")).toBe(
      "HELLO what about annual leave",
    );
  });

  const kept = [
    // A greeting followed by anything that is not the bot's name is untouched.
    "hey team what about the refund policy",
    "hi there what was deployed on Monday?",
    "hello what about annual leave",
  ];
  for (const input of kept) {
    it(`keeps "${input}" byte-identical`, () => {
      expect(stripNameCall(input)).toBe(input);
    });
  }
});

describe("stripNameCall — trailing name-call", () => {
  const cases: Array<[string, string]> = [
    ["can you help, Monday?", "can you help"],
    ["what about annual leave, Monday?", "what about annual leave"],
    ["WHAT ABOUT ANNUAL LEAVE, monday-bot?", "WHAT ABOUT ANNUAL LEAVE"],
  ];
  for (const [input, expected] of cases) {
    it(`strips the trailing name-call from "${input}"`, () => {
      expect(stripNameCall(input)).toBe(expected);
    });
  }

  const kept = [
    // No announcing comma before the weekday → never fire (the load-bearing
    // must-not-fire class: a weekday as a real date).
    "what was deployed on Monday?",
    "is the standup on Monday?",
    "what is due on Monday?",
  ];
  for (const input of kept) {
    it(`keeps "${input}" byte-identical`, () => {
      expect(stripNameCall(input)).toBe(input);
    });
  }
});

describe("stripNameCall — @-mention name-call", () => {
  const cases: Array<[string, string]> = [
    ["hey @monday_bot what is due on Monday?", "hey what is due on Monday?"],
    ["@monday-bot, what about annual leave?", "what about annual leave?"],
    // A sentence-final mention goes wholesale — its trailing punctuation goes
    // with the token, like every other mention shape.
    ["WHAT IS DUE @MONDAY_BOT?", "WHAT IS DUE"],
  ];
  for (const [input, expected] of cases) {
    it(`strips the mention token from "${input}"`, () => {
      expect(stripNameCall(input)).toBe(expected);
    });
  }

  it("keeps a non-bot mention byte-identical in its non-name-call parts", () => {
    // A human-handle mention is never a call to THIS bot.
    const input = "ask @dev_dana about the refund policy, monday?";
    expect(stripNameCall(input)).toBe("ask @dev_dana about the refund policy");
  });
});

describe("stripNameCall — weekday content must-not-fire (AC-5 corpus)", () => {
  const kept = [
    "what was deployed on Monday?",
    "is the standup on Monday?",
    "deploy runs every Monday at noon",
    "what changed in the Monday release?",
  ];
  for (const input of kept) {
    it(`keeps "${input}" byte-identical`, () => {
      expect(stripNameCall(input)).toBe(input);
    });
  }
});

describe("stripNameCall — mixed name-call + real date (AC-6)", () => {
  it("drops the leading name-call AND preserves the second, real-date Monday", () => {
    expect(stripNameCall("Monday, what is due on Monday?")).toBe(
      "what is due on Monday?",
    );
  });
});

describe("stripNameCall — compose arm", () => {
  it("cleans both ends of a doubly-addressed question", () => {
    expect(stripNameCall("Monday, what is due, Monday?")).toBe("what is due");
  });
});

describe("stripNameCall — single source of truth (AC-8)", () => {
  // Driven by BOT_NAME_TOKENS itself: every token in the ONE constant behaves
  // as a leading name-call, so a future token added there is covered with no
  // test edit.
  for (const token of BOT_NAME_TOKENS) {
    it(`treats "${token}" from BOT_NAME_TOKENS as a leading name-call`, () => {
      expect(stripNameCall(`${token}, what about annual leave?`)).toBe(
        "what about annual leave?",
      );
    });
  }

  it("has at least the shipped name tokens", () => {
    expect(BOT_NAME_TOKENS.length).toBeGreaterThan(0);
  });
});

describe("stripNameCall — degenerate inputs", () => {
  it("returns the input untouched when only a name-call remains", () => {
    const input = "Monday,";
    expect(stripNameCall(input)).toBe(input);
  });

  it("returns empty/whitespace input untouched", () => {
    expect(stripNameCall("")).toBe("");
    expect(stripNameCall("   ")).toBe("   ");
  });
});
