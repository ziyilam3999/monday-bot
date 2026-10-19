import { classifyHelpGate } from "../src/telegram/helpGate";

/**
 * #3306 — PURE pre-retrieval gate tables (P1/P2a/P2b), mirroring the
 * `classifyMentionIntent` test shape. Zero network, zero fixtures. Every
 * must-not-fire row is today's doc path: `{ card: false, arm: null }`.
 */

describe("help gate — P1: unknown Telegram slash command fires the card", () => {
  const fires = ["/model", "/start", "/HELP", "/model@monday_bot", "/foo!", "/sync-confluence"];
  for (const text of fires) {
    it(`fires for "${text}"`, () => {
      expect(classifyHelpGate(text)).toEqual({ card: true, arm: "command" });
    });
  }

  const docs = [
    "/ask how many days of annual leave do I get?",
    "/jql show me crashes",
    "/ask@monday_bot how many days of annual leave do I get?",
    "what does /model mean in the slack adapter",
    "/api/v1/users what does this return",
    "/etc/hosts",
    "https://example.com/v1/users what does this endpoint return",
  ];
  for (const text of docs) {
    it(`keeps the doc path for "${text}"`, () => {
      expect(classifyHelpGate(text)).toEqual({ card: false, arm: null });
    });
  }
});

describe("help gate — P2a: short greeting fires the card", () => {
  const fires = [
    "hi",
    "Hello there!",
    "good morning everyone",
    "hello monday",
    "hi @monday_bot",
    "hello?",
    "Hi.",
    "hi 👋",
  ];
  for (const text of fires) {
    it(`fires for "${text}"`, () => {
      expect(classifyHelpGate(text)).toEqual({ card: true, arm: "greeting" });
    });
  }

  const docs = [
    "hi, list the localisation placeholder in the strings file",
    "hi DEMO-673",
    "hey what about annual leave",
    "hello monday, what about annual leave",
    "good bug report",
  ];
  for (const text of docs) {
    it(`keeps the doc path for "${text}"`, () => {
      expect(classifyHelpGate(text)).toEqual({ card: false, arm: null });
    });
  }
});

describe("help gate — P2b: whole-message help probe fires the card", () => {
  const fires = ["help", "What can you do?", "commands", "what do you do", "How does this work?"];
  for (const text of fires) {
    it(`fires for "${text}"`, () => {
      expect(classifyHelpGate(text)).toEqual({ card: true, arm: "help" });
    });
  }

  const docs = [
    "help me find the localisation placeholder",
    "what can you do about crashes",
    "commands in the deploy script",
  ];
  for (const text of docs) {
    it(`keeps the doc path for "${text}"`, () => {
      expect(classifyHelpGate(text)).toEqual({ card: false, arm: null });
    });
  }
});

describe("help gate — safe default", () => {
  it("empty / whitespace-only / non-string input never fires", () => {
    expect(classifyHelpGate("")).toEqual({ card: false, arm: null });
    expect(classifyHelpGate("   ")).toEqual({ card: false, arm: null });
  });

  it("an ordinary doc question never fires", () => {
    expect(classifyHelpGate("how do I request a new laptop?")).toEqual({
      card: false,
      arm: null,
    });
  });

  it("a lone @-mention with no greeting word never fires", () => {
    expect(classifyHelpGate("@monday_bot")).toEqual({ card: false, arm: null });
  });
});
