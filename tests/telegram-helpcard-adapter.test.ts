import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TelegramAdapter, AnswerProvider } from "../src/telegram/adapter";
import { TgUpdate } from "../src/telegram/transport";
import { handleQuery } from "../src/slack/queryHandler";
import { renderTelegramReply } from "../src/telegram/formatter";
import { CARD_ASK_LINE, CARD_GREETING_LINE } from "../src/telegram/helpCard";
import { SHARED_CAPABILITY_DESCRIPTION } from "../src/capabilities";

/**
 * #3306 — adapter-level ACs. Every test drives `processUpdate` with a fake
 * transport (via `transportFactory`), a fake knowledge service, and an ask-log
 * path overridden to a scratch file. Inline `TgUpdate` fixtures only — no
 * network, no live bot, the only project-key-looking string is DEMO.
 */

const CHAT_ID = 4242;

interface Sent {
  chatId: number;
  text: string;
}

/** Fake knowledge service that records every question it is asked. */
function makeService(queries: string[]): AnswerProvider {
  return {
    async query(question: string) {
      queries.push(question);
      return { answer: `stub answer for testing`, citations: [] };
    },
  };
}

function makeAdapter(
  sent: Sent[],
  queries: string[],
  askLogPath: string,
): TelegramAdapter {
  return new TelegramAdapter({
    botToken: "000000:test-token-shape",
    allowedChatIds: [CHAT_ID],
    knowledgeService: makeService(queries),
    transportFactory: () => ({
      async getUpdates() {
        return [];
      },
      async sendMessage(chatId: number, text: string) {
        sent.push({ chatId, text });
      },
    }),
    askLogPath,
    nowFn: () => 1700000000000,
  });
}

function update(text: string, chatId = CHAT_ID): TgUpdate {
  return { update_id: 1, message: { chat: { id: chatId }, text } };
}

function isCard(text: string): boolean {
  return text.includes(CARD_ASK_LINE);
}

function askLogLines(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
}

/** The byte-identical doc-path reply today's pipeline produces for a question. */
async function expectedDocReply(text: string): Promise<string> {
  const service: AnswerProvider = {
    async query() {
      return { answer: "stub answer for testing", citations: [] };
    },
  };
  return renderTelegramReply(await handleQuery(text, service));
}

let scratchDir: string;
let logPath: string;

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "3306-asklog-"));
  logPath = path.join(scratchDir, "asks.jsonl");
});

afterEach(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe("AC-1 — P1 unknown slash command: one card, zero queries", () => {
  for (const text of ["/model", "/start", "/HELP", "/model@monday_bot"]) {
    it(`card for "${text}"`, async () => {
      const sent: Sent[] = [];
      const queries: string[] = [];
      await makeAdapter(sent, queries, logPath).processUpdate(update(text));
      expect(queries).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0].chatId).toBe(CHAT_ID);
      expect(sent[0].text).toContain(SHARED_CAPABILITY_DESCRIPTION);
      expect(sent[0].text).not.toContain("Sources:");
      expect(askLogLines(logPath)).toHaveLength(0);
    });
  }
});

describe("AC-2 — P1 pass-through: byte-identical doc path", () => {
  const docs = [
    "/ask how many days of annual leave do I get?",
    "/jql show me crashes",
    "what does /model mean in the slack adapter",
    "/api/v1/users what does this return",
    "/etc/hosts",
    "https://example.com/v1/users what does this endpoint return",
  ];
  for (const text of docs) {
    it(`doc path for "${text}"`, async () => {
      const sent: Sent[] = [];
      const queries: string[] = [];
      await makeAdapter(sent, queries, logPath).processUpdate(update(text));
      expect(queries).toEqual([text]); // exactly once, byte-identical
      expect(sent).toHaveLength(1);
      expect(isCard(sent[0].text)).toBe(false);
      expect(sent[0].text).toBe(await expectedDocReply(text));
      expect(askLogLines(logPath)).toHaveLength(1);
    });
  }
});

describe("AC-3 — P2 greeting: greeting-prefixed card, zero queries", () => {
  const fires = [
    "hi",
    "Hello there!",
    "good morning everyone",
    "hello monday",
    "hi @monday_bot",
  ];
  for (const text of fires) {
    it(`card for "${text}"`, async () => {
      const sent: Sent[] = [];
      const queries: string[] = [];
      await makeAdapter(sent, queries, logPath).processUpdate(update(text));
      expect(queries).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0].text.startsWith(`${CARD_GREETING_LINE}\n\n`)).toBe(true);
      expect(sent[0].text).toContain(SHARED_CAPABILITY_DESCRIPTION);
      expect(askLogLines(logPath)).toHaveLength(0);
    });
  }
});

describe("AC-4 — P2 greeting pass-through: byte-identical doc path", () => {
  const docs = [
    "hi, list the localisation placeholder in the strings file",
    "hi DEMO-673",
    "hey what about annual leave",
    "hello monday, what about annual leave",
  ];
  for (const text of docs) {
    it(`doc path for "${text}"`, async () => {
      const sent: Sent[] = [];
      const queries: string[] = [];
      await makeAdapter(sent, queries, logPath).processUpdate(update(text));
      expect(queries).toEqual([text]);
      expect(sent).toHaveLength(1);
      expect(isCard(sent[0].text)).toBe(false);
      expect(sent[0].text).toBe(await expectedDocReply(text));
    });
  }
});

describe("AC-5 — P2 help probe: card, zero queries", () => {
  for (const text of ["help", "What can you do?", "commands"]) {
    it(`card for "${text}"`, async () => {
      const sent: Sent[] = [];
      const queries: string[] = [];
      await makeAdapter(sent, queries, logPath).processUpdate(update(text));
      expect(queries).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain(SHARED_CAPABILITY_DESCRIPTION);
      expect(askLogLines(logPath)).toHaveLength(0);
    });
  }
});

describe("AC-6 — P2 help-probe pass-through: byte-identical doc path", () => {
  const docs = [
    "help me find the localisation placeholder",
    "what can you do about crashes",
    "commands in the deploy script",
  ];
  for (const text of docs) {
    it(`doc path for "${text}"`, async () => {
      const sent: Sent[] = [];
      const queries: string[] = [];
      await makeAdapter(sent, queries, logPath).processUpdate(update(text));
      expect(queries).toEqual([text]);
      expect(sent).toHaveLength(1);
      expect(isCard(sent[0].text)).toBe(false);
      expect(sent[0].text).toBe(await expectedDocReply(text));
    });
  }
});

describe("AC-9 — ask-log: cards write nothing, doc asks write one line", () => {
  it("a card update leaves the ask log empty", async () => {
    const sent: Sent[] = [];
    const queries: string[] = [];
    await makeAdapter(sent, queries, logPath).processUpdate(update("hi"));
    expect(askLogLines(logPath)).toHaveLength(0);
  });

  it("a doc update writes exactly one line", async () => {
    const sent: Sent[] = [];
    const queries: string[] = [];
    await makeAdapter(sent, queries, logPath).processUpdate(update("how do I book a meeting room?"));
    const lines = askLogLines(logPath);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).questionLen).toBe("how do I book a meeting room?".length);
  });
});

describe("AC-10 — never spammed", () => {
  it("a batch of non-matching updates produces 0 card sends", async () => {
    const sent: Sent[] = [];
    const queries: string[] = [];
    const adapter = makeAdapter(sent, queries, logPath);
    for (const text of [
      "how do I request a new laptop?",
      "what is the vpn policy?",
      "when is the next holiday?",
    ]) {
      await adapter.processUpdate(update(text, CHAT_ID));
    }
    expect(queries).toHaveLength(3); // every one took the doc path
    expect(sent).toHaveLength(3);
    expect(sent.every((s) => !isCard(s.text))).toBe(true);
  });

  it("each matching update produces exactly one card sendMessage", async () => {
    const sent: Sent[] = [];
    const queries: string[] = [];
    const adapter = makeAdapter(sent, queries, logPath);
    await adapter.processUpdate({ update_id: 1, message: { chat: { id: CHAT_ID }, text: "hi" } });
    await adapter.processUpdate({ update_id: 2, message: { chat: { id: CHAT_ID }, text: "/model" } });
    await adapter.processUpdate({ update_id: 3, message: { chat: { id: CHAT_ID }, text: "help" } });
    expect(queries).toHaveLength(0);
    expect(sent).toHaveLength(3);
    expect(sent.every((s) => isCard(s.text))).toBe(true);
  });
});

describe("AC-12 — existing silence unchanged", () => {
  it("a chat id off the allow-list gets no query, no card, no ask-log line", async () => {
    const sent: Sent[] = [];
    const queries: string[] = [];
    await makeAdapter(sent, queries, logPath).processUpdate(update("hi", 999999));
    expect(queries).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(askLogLines(logPath)).toHaveLength(0);
  });

  it("a disallowed chat asking a doc question is equally silent", async () => {
    const sent: Sent[] = [];
    const queries: string[] = [];
    await makeAdapter(sent, queries, logPath).processUpdate(update("/model", 999999));
    expect(queries).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("a text-less update is silent", async () => {
    const sent: Sent[] = [];
    const queries: string[] = [];
    await makeAdapter(sent, queries, logPath).processUpdate({
      update_id: 1,
      message: { chat: { id: CHAT_ID } },
    });
    expect(queries).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(askLogLines(logPath)).toHaveLength(0);
  });
});
