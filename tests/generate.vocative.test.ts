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

/**
 * Fix cycle 1 (execution review #3323): a comma after "Monday" is not by
 * itself a vocative marker — when the next word continues a date (another
 * weekday, a month, a number/ordinal, or "the"), the leading weekday is a
 * DATE and stays. A time-of-day word before "Monday" ("morning Monday
 * standup?") is not a salutation either. And when an arm does fire, every
 * newline/space run that did not announce a removed token survives verbatim.
 */
describe("stripNameCall — fix cycle 1: leading arm vs date phrases", () => {
  const kept = [
    "Monday, Tuesday and Wednesday: who is on call?",
    "Monday, May 5th is the launch?",
    "Monday, the 3rd - is the office open?",
    "Monday, Wednesday, Friday deploys - what is the schedule?",
    "MONDAY , Tuesday standup - who runs it?",
    "Monday, 5 May - who is on call?",
    "Monday, first of May - is the office open?",
  ];
  for (const input of kept) {
    it(`keeps the date-list/date-phrase leading "${input}" byte-identical`, () => {
      expect(stripNameCall(input)).toBe(input);
    });
  }
});

describe("stripNameCall — fix cycle 1: time-of-day words are not salutations", () => {
  const kept = [
    "morning Monday standup?",
    "Afternoon monday meeting cancelled?",
    "evening Monday shift - who is on?",
    "good morning, is the deploy on Monday?",
    "good Monday morning standup?",
  ];
  for (const input of kept) {
    it(`keeps the time-of-day "${input}" byte-identical`, () => {
      expect(stripNameCall(input)).toBe(input);
    });
  }

  it("still fires after a true salutation", () => {
    expect(stripNameCall("yo MONDAY, summarise the refund policy?")).toBe(
      "yo, summarise the refund policy?",
    );
  });

  it("still fires after 'greetings'", () => {
    expect(stripNameCall("greetings monday-bot, what about annual leave?")).toBe(
      "greetings, what about annual leave?",
    );
  });
});

describe("stripNameCall — fix cycle 1: trailing arm vs weekday lists", () => {
  it("keeps a trailing weekday that closes a day list", () => {
    const input = "which days are deploy days: Tuesday, Monday?";
    expect(stripNameCall(input)).toBe(input);
  });

  it("keeps a trailing weekday list with a mid-sentence weekday", () => {
    const input = "rotating on Friday, Monday and Wednesday?";
    expect(stripNameCall(input)).toBe(input);
  });
});

describe("stripNameCall — fix cycle 1: whitespace survives a fired arm", () => {
  it("preserves interior newlines when the leading arm fires", () => {
    expect(stripNameCall("Monday,\nwhat about leave?\nsecond line")).toBe(
      "what about leave?\nsecond line",
    );
  });

  it("preserves interior space runs when the leading arm fires", () => {
    expect(stripNameCall("Monday,  what   about leave?")).toBe(
      "what   about leave?",
    );
  });

  it("preserves interior newlines when the greeting arm fires", () => {
    expect(stripNameCall("hey Monday,\nsummarise\nthe refund policy?")).toBe(
      "hey, summarise\nthe refund policy?",
    );
  });

  it("preserves interior newlines when the trailing arm fires", () => {
    expect(stripNameCall("can you help\nwith leave,\nMonday?")).toBe(
      "can you help\nwith leave",
    );
  });
});

describe("stripNameCall — fix cycle 1: oversized input fails closed", () => {
  it("returns a past-4096-character input byte-identical without cleaning", () => {
    const input = `Monday, ${"x".repeat(4100)}`;
    expect(input.length).toBeGreaterThan(4096);
    expect(stripNameCall(input)).toBe(input);
  });
});

/**
 * Fix cycle 2 (execution review round 2): the date-word guard covers EVERY
 * date/time word form on BOTH arms — weekday/month abbreviations ("Tue",
 * "Jan", "Sept"), plural weekdays ("Mondays"), day/time words ("tomorrow",
 * "noon", "next week", "at 9am"), and a date or time right before a trailing
 * "Monday?" ("on May 5th, Monday?", "to 9am, Monday?") all keep the weekday.
 * All must-not-fire rows below are RED at the fix-cycle-1 head (377e57c).
 */
describe("stripNameCall — fix cycle 2: abbreviated/plural/time date words (leading)", () => {
  const kept = [
    // review round-2 probes
    "Monday, Tue and Wed: who is on call?",
    "Monday, Jan 5th: what is due?",
    "Monday, Sept 3 - office open?",
    "Monday, Mondays and Fridays are deploy days?",
    "Monday, tomorrow or Friday - which is the deadline?",
    "Monday, morning shift - who is on?",
    "Monday, noon - is the deploy window open?",
    "Monday, next week, who is on call?",
    "Monday, at 9am, is standup on?",
    // my own held-out variants
    "Monday, Thu or Sat: when is the audit?",
    "Monday, Oct 14 - is the office closed?",
    "Monday, tonight or Sunday - when is the backup?",
    "Monday, weekend or weekday - which is the deploy?",
    "Monday, a.m. or p.m. handover - who is on?",
    "Monday, thurs or fri - who runs the review?",
    "Monday, this Friday - is the release cut?",
  ];
  for (const input of kept) {
    it(`keeps the abbreviated/plural/time date phrase "${input}" byte-identical`, () => {
      expect(stripNameCall(input)).toBe(input);
    });
  }
});

describe("stripNameCall — fix cycle 2: trailing arm vs a date before the comma", () => {
  const kept = [
    // review round-2 probes
    "the launch is on May 5th, Monday?",
    "is the deploy on the 3rd, Monday?",
    "standup moved to 9am, Monday?",
    "deploy days are Tue, Monday?",
    // my own held-out variants
    "the audit is due on Dec 1st, Monday?",
    "the freeze lands in feb, Monday?",
    "shift handover is at noon, Monday?",
  ];
  for (const input of kept) {
    it(`keeps the trailing weekday confirming a date "${input}" byte-identical`, () => {
      expect(stripNameCall(input)).toBe(input);
    });
  }
});

describe("stripNameCall — fix cycle 2: the cleaner still fires on real name-calls", () => {
  const cases: Array<[string, string]> = [
    // dispatch held-out set, plus my own replacements (see the close note's
    // PR-TABLE: "thanks Monday, …" is a conservative keep — "thanks" is not
    // in GREETING_LEXICON and this cycle's scope is the date-word guard)
    ["Monday, please list the open support tickets?", "please list the open support tickets?"],
    ["can you check the invoice status, Monday?", "can you check the invoice status"],
    ["Monday, what is the refund window?", "what is the refund window?"],
    ["file the expense report, Monday?", "file the expense report"],
    ["can you summarise the refund policy, Monday?", "can you summarise the refund policy"],
  ];
  for (const [input, expected] of cases) {
    it(`strips the name-call from "${input}"`, () => {
      expect(stripNameCall(input)).toBe(expected);
    });
  }
});

describe("stripNameCall — fix cycle 2: dispatch held-out variants", () => {
  const fire: Array<[string, string]> = [
    [
      "Monday, what is the refund window for annual plans?",
      "what is the refund window for annual plans?",
    ],
    [
      "hey monday-bot, can you list the escalation contacts?",
      "hey, can you list the escalation contacts?",
    ],
    [
      "Monday: where do I find the onboarding checklist",
      "where do I find the onboarding checklist",
    ],
  ];
  for (const [input, expected] of fire) {
    it(`fires on the vocative "${input}"`, () => {
      expect(stripNameCall(input)).toBe(expected);
    });
  }
  const keep = [
    "Can we ship this on Monday, Oct 27?",
    "Is the office open Monday morning?",
    "Deadline is the 3rd, Monday.",
  ];
  for (const input of keep) {
    it(`keeps the calendar reading "${input}" byte-identical`, () => {
      expect(stripNameCall(input)).toBe(input);
    });
  }
});
