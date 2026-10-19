/**
 * #3277 — Telegram adapter suites (consolidated: adapter + formatter +
 * transport + askLog). All tests inject fake transports / fetch stubs: ZERO
 * network, no real token, no call to any messaging API.
 *
 * Token fixtures use the plain non-token-shaped label `tg-token-1`, mirroring
 * the `xoxb-1` convention in tests/slack-adapter.test.ts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  TelegramAdapter,
  TelegramConfigError,
  AnswerProvider,
} from "../src/telegram/adapter";
import {
  TelegramTransport,
  TelegramTransportError,
  HttpTelegramTransport,
  TgUpdate,
} from "../src/telegram/transport";
import { renderTelegramReply, splitMessage } from "../src/telegram/formatter";
import { chatIdHash, recordAsk } from "../src/telegram/askLog";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeKnowledge(
  behavior: "ok" | "throw" | "long" = "ok",
): AnswerProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(question: string) {
      calls.push(question);
      if (behavior === "throw") throw new Error("knowledge backend exploded");
      if (behavior === "long") {
        const citations = Array.from({ length: 350 }, (_, i) => ({
          num: i + 1,
          source: `doc-${i + 1}.md`,
        }));
        return { answer: "A".repeat(900), citations };
      }
      return {
        answer: `You get 25 days. [1]`,
        citations: [{ num: 1, source: "doc-a.md", heading: "Intro" }],
      };
    },
  };
}

type ScriptStep =
  | { kind: "ok"; updates?: TgUpdate[] }
  | { kind: "err"; error: Error }
  | { kind: "pending" };

/** Scripted transport: each getUpdates consumes one step; beyond the script it
 * returns a never-settling promise (so no test ever spins the poll loop). */
class FakeTransport implements TelegramTransport {
  getUpdatesCalls: Array<{ offset: number; timeout: number }> = [];
  sendMessageCalls: Array<{ chatId: number; text: string }> = [];
  abortCount = 0;
  private readonly script: ScriptStep[];
  private readonly defaultStep: ScriptStep;

  constructor(script: ScriptStep[] = [], defaultStep: ScriptStep = { kind: "pending" }) {
    this.script = [...script];
    this.defaultStep = defaultStep;
  }

  private next(): ScriptStep {
    return this.script.length > 0 ? (this.script.shift() as ScriptStep) : this.defaultStep;
  }

  async getUpdates(offset: number, timeout: number): Promise<TgUpdate[]> {
    this.getUpdatesCalls.push({ offset, timeout });
    const step = this.next();
    if (step.kind === "err") throw step.error;
    if (step.kind === "pending") return new Promise<TgUpdate[]>(() => undefined);
    return step.updates ?? [];
  }

  async sendMessage(chatId: number, text: string): Promise<unknown> {
    this.sendMessageCalls.push({ chatId, text });
    return { ok: true };
  }

  abortInFlight(): void {
    this.abortCount += 1;
  }
}

/** Manually-controlled sleep: records delays, resolves only when the test says. */
function makeSleep() {
  const delays: number[] = [];
  let pendingResolve: (() => void) | null = null;
  return {
    delays,
    sleepFn: (ms: number): Promise<void> => {
      delays.push(ms);
      return new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
    },
    resolvePending: (): void => {
      pendingResolve?.();
      pendingResolve = null;
    },
  };
}

async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function tmpLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-tg-"));
  return path.join(dir, "asks.jsonl");
}

function update(updateId: number, chatId: number | undefined, text?: string): TgUpdate {
  return {
    update_id: updateId,
    message:
      chatId === undefined
        ? undefined
        : {
            chat: { id: chatId },
            ...(text === undefined ? {} : { text }),
          },
  };
}

const ALLOWED = [42];

// Fixed injected clocks (fix round 1, finding 1): ask-log assertions must
// never key on real-clock timestamp digits. FIXED_CLOCK_ISO contains no "42";
// FIXED_COLLIDING_CLOCK_ISO deliberately contains "42" three times — the
// targeted assertion set has to hold for BOTH.
const FIXED_CLOCK_MS = Date.parse("2025-10-09T08:53:20.000Z");
const FIXED_CLOCK_ISO = "2025-10-09T08:53:20.000Z";
const FIXED_COLLIDING_CLOCK_MS = Date.parse("2025-10-09T12:42:42.424Z");
const FIXED_COLLIDING_CLOCK_ISO = "2025-10-09T12:42:42.424Z";

// ---------------------------------------------------------------------------
// adapter — config validation
// ---------------------------------------------------------------------------

describe("telegram/adapter — config validation (fail closed)", () => {
  it("throws TelegramConfigError on empty botToken", () => {
    expect(
      () =>
        new TelegramAdapter({
          botToken: "",
          allowedChatIds: ALLOWED,
          knowledgeService: fakeKnowledge(),
        }),
    ).toThrow(TelegramConfigError);
  });

  it("throws TelegramConfigError when knowledgeService has no query method", () => {
    expect(
      () =>
        new TelegramAdapter({
          botToken: "tg-token-1",
          allowedChatIds: ALLOWED,
          knowledgeService: {} as never,
        }),
    ).toThrow(TelegramConfigError);
  });

  it("AC5 — empty allowedChatIds throws TelegramConfigError naming TELEGRAM_ALLOWED_CHAT_IDS", () => {
    expect(
      () =>
        new TelegramAdapter({
          botToken: "tg-token-1",
          allowedChatIds: [],
          knowledgeService: fakeKnowledge(),
        }),
    ).toThrow(/TELEGRAM_ALLOWED_CHAT_IDS/);
  });
});

// ---------------------------------------------------------------------------
// adapter — allow-list gating
// ---------------------------------------------------------------------------

describe("telegram/adapter — allow-list gating", () => {
  it("AC3/AC4 — disallowed chat id: zero sendMessage, zero query, zero log lines", async () => {
    const service = fakeKnowledge();
    const transport = new FakeTransport();
    const logPath = tmpLogPath();
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: service,
      transportFactory: () => transport,
      askLogPath: logPath,
    });

    await adapter.processUpdate(update(1, 999, "what is the leave policy?"));

    expect(transport.sendMessageCalls.length).toBe(0);
    expect(service.calls.length).toBe(0);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("text-less update is ignored (no query, no sendMessage)", async () => {
    const service = fakeKnowledge();
    const transport = new FakeTransport();
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: service,
      transportFactory: () => transport,
    });

    await adapter.processUpdate(update(1, 42)); // no text
    await adapter.processUpdate(update(2, undefined, "hi")); // no message at all

    expect(transport.sendMessageCalls.length).toBe(0);
    expect(service.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// adapter — allowed asks
// ---------------------------------------------------------------------------

describe("telegram/adapter — allowed asks", () => {
  it("allowed ask → one query + one rendered plain-text reply + one ask-log line", async () => {
    const service = fakeKnowledge();
    const transport = new FakeTransport();
    const logPath = tmpLogPath();
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: service,
      transportFactory: () => transport,
      askLogPath: logPath,
      nowFn: () => FIXED_CLOCK_MS,
    });

    await adapter.processUpdate(update(1, 42, "what is the leave policy?"));

    expect(service.calls).toEqual(["what is the leave policy?"]);
    expect(transport.sendMessageCalls.length).toBe(1);
    const sent = transport.sendMessageCalls[0];
    expect(sent.chatId).toBe(42);
    expect(sent.text).toContain("You get 25 days.");
    expect(sent.text).toContain("Sources:");
    expect(sent.text).toContain("[1] doc-a.md — Intro");
    expect(sent.text).not.toContain("*"); // mrkdwn emphasis stripped

    // AC9 — exactly one JSON line, exact key set, no raw chat id / question text.
    const raw = fs.readFileSync(logPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual([
      "chatHash",
      "cited",
      "latencyMs",
      "questionLen",
      "ts",
    ]);
    expect(entry.chatHash).toMatch(/^[0-9a-f]{12}$/);
    expect(entry.questionLen).toBe("what is the leave policy?".length);
    expect(entry.cited).toBe(true);
    expect(typeof entry.latencyMs).toBe("number");
    expect((entry.latencyMs as number)).toBeGreaterThanOrEqual(0);
    expect(entry.ts).toBe(FIXED_CLOCK_ISO); // the injected clock, not the real one
    expect(Number.isNaN(Date.parse(entry.ts as string))).toBe(false);
    expect(raw).not.toContain("what is the leave policy?");
    // Raw chat id never stored — assertions target ONLY the id-bearing
    // fields: chatHash must equal the id's hash (the id appears solely in
    // hashed form) and the numeric/boolean fields are digit-scanned. The ts
    // field is EXCLUDED on purpose: any digit pair occurs in some timestamp,
    // which is what made the old whole-line not.toContain("42") flaky.
    expect(entry.chatHash).toBe(chatIdHash(42));
    expect(
      JSON.stringify({
        questionLen: entry.questionLen,
        cited: entry.cited,
        latencyMs: entry.latencyMs,
      }),
    ).not.toContain("42");
  });

  it("AC7 — rendered reply over 4096 chars → one sendMessage per part, each ≤4096", async () => {
    const service = fakeKnowledge("long");
    const transport = new FakeTransport();
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: service,
      transportFactory: () => transport,
      askLogPath: tmpLogPath(),
    });

    await adapter.processUpdate(update(1, 42, "give me everything"));

    expect(transport.sendMessageCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of transport.sendMessageCalls) {
      expect(call.text.length).toBeLessThanOrEqual(4096);
    }
    const joined = transport.sendMessageCalls.map((c) => c.text).join("");
    expect(joined.length).toBeGreaterThan(4096);
  });

  it("AC10 — service throws → friendly fallback reply (never an error string), cited:false", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const service = fakeKnowledge("throw");
    const transport = new FakeTransport();
    const logPath = tmpLogPath();
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: service,
      transportFactory: () => transport,
      askLogPath: logPath,
    });

    await expect(adapter.processUpdate(update(1, 42, "what is the travel policy?"))).resolves.toBeUndefined();

    expect(transport.sendMessageCalls.length).toBe(1);
    expect(transport.sendMessageCalls[0].text).toContain(
      "Sorry, I'm having trouble reaching the knowledge service",
    );
    expect(transport.sendMessageCalls[0].text).not.toContain("exploded");
    const entry = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(entry.cited).toBe(false);
    errSpy.mockRestore();
  });

  it("mid-batch sendMessage failure is caught: no throw, no crash, ask logged (offset still advances)", async () => {
    const service = fakeKnowledge();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const logPath = tmpLogPath();
    const sendAttempts: Array<{ chatId: number; text: string }> = [];
    const transport: TelegramTransport = {
      getUpdates: async () => [],
      sendMessage: async (chatId: number, text: string) => {
        sendAttempts.push({ chatId, text });
        throw new TelegramTransportError("sendMessage failed: HTTP 500");
      },
    };
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: service,
      transportFactory: () => transport,
      askLogPath: logPath,
    });

    await expect(adapter.processUpdate(update(7, 42, "ping"))).resolves.toBeUndefined();
    expect(sendAttempts.length).toBe(1);
    expect(fs.existsSync(logPath)).toBe(true); // ask still recorded
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// fix round 1, finding 1 — ask-log determinism (injected clock)
// ---------------------------------------------------------------------------

describe("fix1-F1 — ask-log determinism (injected clock)", () => {
  const ASK_KEYS = ["chatHash", "cited", "latencyMs", "questionLen", "ts"];

  /** The fix-round assertion set: exact key set, the id ONLY in hashed form,
   * and a digit scan of the id-BEARING fields only (never the ts). */
  function assertNoRawChatId(
    entry: Record<string, unknown>,
    rawLine: string,
    chatId: number,
  ): void {
    expect(Object.keys(entry).sort()).toEqual(ASK_KEYS);
    expect(entry.chatHash).toBe(chatIdHash(chatId));
    expect(
      JSON.stringify({
        questionLen: entry.questionLen,
        cited: entry.cited,
        latencyMs: entry.latencyMs,
      }),
    ).not.toContain(String(chatId));
    expect(rawLine).not.toContain("what is the leave policy?");
  }

  it("holds for a full day of injected ts values (every minute + every second of a colliding-rich hour)", () => {
    const logPath = tmpLogPath();
    const midnight = Date.parse("2025-10-09T00:00:00.000Z");
    const stamps: number[] = [];
    for (let m = 0; m < 1440; m++) stamps.push(midnight + m * 60_000);
    for (let sec = 0; sec < 3600; sec++) {
      stamps.push(midnight + 12 * 3_600_000 + sec * 1000); // the 12:xx hour
    }
    for (const ms of stamps) {
      recordAsk(
        { chatId: 42, questionLen: 25, cited: true, latencyMs: 7 },
        logPath,
        () => new Date(ms),
      );
    }
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(stamps.length);
    let colliding = 0;
    lines.forEach((line, i) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry.ts).toBe(new Date(stamps[i]).toISOString());
      assertNoRawChatId(entry, line, 42);
      if ((entry.ts as string).includes("42")) colliding += 1;
    });
    // The sweep genuinely covers ts values containing the chat id's digits —
    // the OLD whole-line not.toContain("42") failed on exactly these (~5.2%
    // of a UTC day, i.e. npm test flaked about 1 run in 19).
    expect(colliding).toBeGreaterThan(0);
  });

  it("an adapter ask under a colliding pinned clock (ts contains \"42\" three times) still passes", async () => {
    const transport = new FakeTransport();
    const logPath = tmpLogPath();
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: fakeKnowledge(),
      transportFactory: () => transport,
      askLogPath: logPath,
      nowFn: () => FIXED_COLLIDING_CLOCK_MS,
    });

    await adapter.processUpdate(update(1, 42, "what is the leave policy?"));

    const line = fs.readFileSync(logPath, "utf8").trim();
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.ts).toBe(FIXED_COLLIDING_CLOCK_ISO);
    expect(entry.latencyMs).toBe(0); // constant clock → deterministic latency
    assertNoRawChatId(entry, line, 42);
  });
});

// ---------------------------------------------------------------------------
// adapter — poll loop: boot drain, backoff, park, stop
// ---------------------------------------------------------------------------

describe("telegram/adapter — poll loop policy", () => {
  function makeAdapter(script: ScriptStep[], sleep: ReturnType<typeof makeSleep>) {
    const transport = new FakeTransport(script);
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: fakeKnowledge(),
      transportFactory: () => transport,
      askLogPath: tmpLogPath(),
      sleepFn: sleep.sleepFn,
      // Backoff-schedule tests assert EXACT delay arrays; the minimum-poll
      // pace (covered by its own fix1-F3 tests) would interleave 1000s.
      minPollIntervalMs: 0,
    });
    return { adapter, transport };
  }

  it("boot drain: queued update is acknowledged and DISCARDED, next poll uses its id + 1", async () => {
    const service = fakeKnowledge();
    const transport = new FakeTransport([
      { kind: "ok", updates: [update(5, 42, "sent while bot was down")] },
    ]);
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: service,
      transportFactory: () => transport,
      askLogPath: tmpLogPath(),
      sleepFn: makeSleep().sleepFn,
    });

    await adapter.start();
    await settle();
    expect(transport.getUpdatesCalls[0]).toEqual({ offset: -1, timeout: 0 });
    expect(service.calls.length).toBe(0); // discarded — never answered
    expect(transport.sendMessageCalls.length).toBe(0);
    expect(transport.getUpdatesCalls[1]?.offset).toBe(6);
    await adapter.stop();
  });

  it("boot drain: empty queue → next poll uses offset 0", async () => {
    const { adapter, transport } = makeAdapter([{ kind: "ok", updates: [] }], makeSleep());
    await adapter.start();
    await settle();
    expect(transport.getUpdatesCalls[1]?.offset).toBe(0);
    await adapter.stop();
  });

  it("boot-drain failure rejects start() (fail-closed at boot)", async () => {
    const { adapter } = makeAdapter(
      [{ kind: "err", error: new Error("boot boom") }],
      makeSleep(),
    );
    await expect(adapter.start()).rejects.toBeInstanceOf(TelegramTransportError);
  });

  it("AC12 — reject once: second getUpdates only after sleepFn (≥5000) resolves; success resets", async () => {
    const sleep = makeSleep();
    const { adapter, transport } = makeAdapter(
      [{ kind: "ok", updates: [] }, { kind: "err", error: new Error("blip") }],
      sleep,
    );
    await adapter.start(); // boot ok (call 1)
    await settle();
    expect(transport.getUpdatesCalls.length).toBe(2); // failed poll (call 2)
    expect(sleep.delays).toEqual([5000]);
    await settle();
    expect(transport.getUpdatesCalls.length).toBe(2); // held: sleepFn unresolved
    sleep.resolvePending();
    await settle();
    expect(transport.getUpdatesCalls.length).toBe(3); // retry only after sleep
    await adapter.stop();
  });

  it("AC12 — delays double 5000→10000→20000→40000→60000→60000; success resets floor to 5000", async () => {
    const sleep = makeSleep();
    const script: ScriptStep[] = [{ kind: "ok", updates: [] }];
    for (let i = 0; i < 6; i++) script.push({ kind: "err", error: new Error("blip") });
    script.push({ kind: "ok", updates: [] });
    script.push({ kind: "err", error: new Error("blip") });
    const { adapter, transport } = makeAdapter(script, sleep);
    await adapter.start();
    // Drive each backoff sleep in order.
    while (sleep.delays.length < 7) {
      await settle();
      sleep.resolvePending();
      await settle();
    }
    expect(sleep.delays).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 5000]);
    await adapter.stop();
  });

  it("AC13 — 10 consecutive rejections → getUpdates frozen, exactly one park line", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const sleep = makeSleep();
    const script: ScriptStep[] = [{ kind: "ok", updates: [] }];
    for (let i = 0; i < 10; i++) script.push({ kind: "err", error: new Error("down") });
    const { adapter, transport } = makeAdapter(script, sleep);
    await adapter.start();
    while (sleep.delays.length < 9) {
      await settle();
      sleep.resolvePending();
      await settle();
    }
    sleep.resolvePending();
    await settle();
    await adapter._loopDone();
    // 1 boot + 10 failed polls = 11 calls, then frozen (no 12th).
    expect(transport.getUpdatesCalls.length).toBe(11);
    await settle();
    expect(transport.getUpdatesCalls.length).toBe(11);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = errSpy.mock.calls[0]?.join(" ") ?? "";
    expect(line).toContain("parking");
    expect(line).not.toContain("down"); // normalized text only — never the raw cause
    errSpy.mockRestore();
  });

  it("AC13 — stop() during a pending backoff sleep: loop settles, no further getUpdates, fetch aborted", async () => {
    const sleep = makeSleep();
    const { adapter, transport } = makeAdapter(
      [{ kind: "ok", updates: [] }, { kind: "err", error: new Error("blip") }],
      sleep,
    );
    await adapter.start();
    await settle();
    expect(transport.getUpdatesCalls.length).toBe(2);
    expect(sleep.delays).toEqual([5000]);
    adapter.stop(); // sleep still pending
    await adapter._loopDone();
    await settle();
    expect(transport.getUpdatesCalls.length).toBe(2); // no retry after stop
    expect(transport.abortCount).toBe(1);
  });

  it("fix1-F4 — stop() during a pending backoff sleep leaves NO pending timer handle", async () => {
    jest.useFakeTimers();
    try {
      const transport = new FakeTransport([
        { kind: "ok", updates: [] },
        { kind: "err", error: new Error("blip") },
      ]);
      const adapter = new TelegramAdapter({
        botToken: "tg-token-1",
        allowedChatIds: ALLOWED,
        knowledgeService: fakeKnowledge(),
        transportFactory: () => transport,
        askLogPath: tmpLogPath(),
      });
      await adapter.start();
      // Microtask flush only (no settle(): its 5ms setTimeout is faked here) —
      // lets the loop reach the 5000ms default-sleep backoff timer.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(jest.getTimerCount()).toBe(1); // exactly the pending backoff timer
      adapter.stop();
      // The default sleepFn's setTimeout must be CLEARED, not just raced: a
      // dangling 5-60s handle keeps the process alive after a clean stop().
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("fix1-F3 — instant EMPTY poll is held to the minimum pace floor before re-polling", async () => {
    const sleep = makeSleep();
    const transport = new FakeTransport([
      { kind: "ok", updates: [] }, // drain: instant empty
      { kind: "ok", updates: [] }, // loop poll 1: instant empty
    ]);
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: fakeKnowledge(),
      transportFactory: () => transport,
      askLogPath: tmpLogPath(),
      sleepFn: sleep.sleepFn,
    });
    await adapter.start();
    await settle();
    expect(transport.getUpdatesCalls.length).toBe(2);
    expect(sleep.delays).toEqual([1000]); // pace floor charged before a 3rd poll
    await settle();
    expect(transport.getUpdatesCalls.length).toBe(2); // held: pace sleep unresolved
    sleep.resolvePending();
    await settle();
    expect(transport.getUpdatesCalls.length).toBe(3); // re-poll only after the floor
    await adapter.stop();
  });

  it("fix1-F3 — a NON-empty batch is answered with no added pace delay", async () => {
    const sleep = makeSleep();
    const transport = new FakeTransport([
      { kind: "ok", updates: [] }, // drain
      { kind: "ok", updates: [update(10, 42, "what is the expense policy?")] },
      { kind: "pending" },
    ]);
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: fakeKnowledge(),
      transportFactory: () => transport,
      askLogPath: tmpLogPath(),
      sleepFn: sleep.sleepFn,
    });
    await adapter.start();
    await settle();
    expect(transport.sendMessageCalls.length).toBe(1); // answered
    expect(sleep.delays).toEqual([]); // no pace sleep, no backoff — batch work only
    await adapter.stop();
  });

  it("fix1-F3 — stop() during a pending pace sleep cuts it short (no further polls)", async () => {
    const sleep = makeSleep();
    const transport = new FakeTransport([
      { kind: "ok", updates: [] },
      { kind: "ok", updates: [] },
    ]);
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: fakeKnowledge(),
      transportFactory: () => transport,
      askLogPath: tmpLogPath(),
      sleepFn: sleep.sleepFn,
    });
    await adapter.start();
    await settle();
    expect(transport.getUpdatesCalls.length).toBe(2);
    expect(sleep.delays).toEqual([1000]);
    adapter.stop(); // pace sleep still pending
    await adapter._loopDone();
    await settle();
    expect(transport.getUpdatesCalls.length).toBe(2); // no re-poll after stop
    expect(transport.abortCount).toBe(1);
  });

  it("fix1-F3 — real timers: an instantly-empty transport cannot spin (bounded polls/sec)", async () => {
    const transport = new FakeTransport([], { kind: "ok", updates: [] }); // instant empty forever
    const adapter = new TelegramAdapter({
      botToken: "tg-token-1",
      allowedChatIds: ALLOWED,
      knowledgeService: fakeKnowledge(),
      transportFactory: () => transport,
      askLogPath: tmpLogPath(),
    });
    await adapter.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 1300));
    adapter.stop();
    await adapter._loopDone();
    // 1s floor between polls: drain + at most ~2 polls in 1.3s. Without the
    // floor an instantly-empty transport spins microtask-only (thousands of
    // polls, event loop starved so badly this test's own stop timer cannot fire).
    expect(transport.getUpdatesCalls.length).toBeLessThanOrEqual(4);
  }, 10000);

  it("fix1-F3 — stop() also clears a pending pace-sleep timer handle", async () => {
    jest.useFakeTimers();
    try {
      const transport = new FakeTransport([
        { kind: "ok", updates: [] },
        { kind: "ok", updates: [] },
      ]);
      const adapter = new TelegramAdapter({
        botToken: "tg-token-1",
        allowedChatIds: ALLOWED,
        knowledgeService: fakeKnowledge(),
        transportFactory: () => transport,
        askLogPath: tmpLogPath(),
      });
      await adapter.start();
      for (let i = 0; i < 20; i++) await Promise.resolve(); // loop reaches the pace sleep
      expect(jest.getTimerCount()).toBe(1); // exactly the 1000ms pace timer
      adapter.stop();
      expect(jest.getTimerCount()).toBe(0); // cleared too — no dangling handle
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// formatter
// ---------------------------------------------------------------------------

describe("telegram/formatter", () => {
  it("renders text + Sources block, stripping mrkdwn emphasis pairs", () => {
    const rendered = renderTelegramReply({
      text: "Answer with *bold* bit",
      blocks: [
        { type: "divider" },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: "*[1]* doc-a.md — Intro" },
            { type: "mrkdwn", text: "*[2]* doc-b.md" },
          ],
        },
      ],
    });
    expect(rendered).toBe("Answer with bold bit\n\nSources:\n[1] doc-a.md — Intro\n[2] doc-b.md");
    expect(rendered).not.toContain("*");
  });

  it("renders bare text when no blocks are present", () => {
    expect(renderTelegramReply({ text: "Plain answer" })).toBe("Plain answer");
  });

  it("AC7 — splitMessage: >4096 with no newline → hard slices, each ≤4096, concat preserves", () => {
    const input = "x".repeat(10000);
    const parts = splitMessage(input, 4096);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096);
    expect(parts.join("")).toBe(input);
  });

  it("splitMessage prefers the last newline before the limit", () => {
    const input = `${"a".repeat(4000)}\n${"b".repeat(1000)}`;
    const parts = splitMessage(input, 4096);
    expect(parts.length).toBe(2);
    // Split AT the newline (4001, not 4096); the boundary newline stays in the
    // part so the concatenation is byte-exact.
    expect(parts[0]).toBe(`${"a".repeat(4000)}\n`);
    expect(parts[1]).toBe("b".repeat(1000));
    expect(parts.join("")).toBe(input);
  });

  it("splitMessage leaves short text as a single part", () => {
    expect(splitMessage("short", 4096)).toEqual(["short"]);
  });
});

// ---------------------------------------------------------------------------
// transport (injected fetch stub — zero network)
// ---------------------------------------------------------------------------

describe("telegram/transport", () => {
  function makeFetchStub() {
    const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
    type StubResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
    const stub = {
      calls,
      respond: { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as StubResponse,
      rejectWith: null as Error | null,
      async fn(url: string, init?: Record<string, unknown>) {
        calls.push({ url, init });
        if (stub.rejectWith) throw stub.rejectWith;
        return stub.respond;
      },
    };
    return stub;
  }

  it("getUpdates posts offset + timeout to the getUpdates method path", async () => {
    const stub = makeFetchStub();
    const transport = new HttpTelegramTransport({ botToken: "tg-token-1", fetchFn: stub.fn });
    await transport.getUpdates(-1, 25);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].url).toBe("https://api.telegram.org/bottg-token-1/getUpdates");
    const body = JSON.parse(String(stub.calls[0].init?.body));
    expect(body).toEqual({ offset: -1, timeout: 25 });
  });

  it("AC11 — sendMessage posts chat_id + text with NO parse_mode (plain text)", async () => {
    const stub = makeFetchStub();
    stub.respond = { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    const transport = new HttpTelegramTransport({ botToken: "tg-token-1", fetchFn: stub.fn });
    await transport.sendMessage(42, "hello");
    expect(stub.calls[0].url).toBe("https://api.telegram.org/bottg-token-1/sendMessage");
    const body = JSON.parse(String(stub.calls[0].init?.body));
    expect(body).toEqual({ chat_id: 42, text: "hello" });
    expect("parse_mode" in body).toBe(false);
  });

  it("AC14 — fetch rejection embedding a URL-shaped message yields a redacted error", async () => {
    const stub = makeFetchStub();
    stub.rejectWith = new TypeError(
      "getaddrinfo ENOTFOUND api.telegram.org bottg-token-1 getUpdates",
    );
    const transport = new HttpTelegramTransport({ botToken: "tg-token-1", fetchFn: stub.fn });
    let thrown: unknown;
    try {
      await transport.getUpdates(0, 25);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TelegramTransportError);
    const message = (thrown as Error).message;
    expect(message).toContain("getUpdates");
    expect(message).toContain("TypeError"); // class name only
    expect(message).not.toContain("api.telegram.org");
    expect(message).not.toContain("/bot");
    expect(message).not.toContain("tg-token-1");
  });

  it("AC14 — non-2xx response yields method + HTTP status only", async () => {
    const stub = makeFetchStub();
    stub.respond = { ok: false, status: 401, json: async () => ({ ok: false }) };
    const transport = new HttpTelegramTransport({ botToken: "tg-token-1", fetchFn: stub.fn });
    await expect(transport.sendMessage(42, "hi")).rejects.toThrow(
      "sendMessage failed: HTTP 401",
    );
  });

  it("200 with ok:false body yields a normalized error (no API description echoed)", async () => {
    const stub = makeFetchStub();
    stub.respond = {
      ok: true,
      status: 200,
      json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
    };
    const transport = new HttpTelegramTransport({ botToken: "tg-token-1", fetchFn: stub.fn });
    await expect(transport.getUpdates(0, 0)).rejects.toThrow(
      /getUpdates failed: unexpected API response/,
    );
  });

  it("malformed JSON body yields a normalized error", async () => {
    const stub = makeFetchStub();
    stub.respond = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    };
    const transport = new HttpTelegramTransport({ botToken: "tg-token-1", fetchFn: stub.fn });
    await expect(transport.getUpdates(0, 0)).rejects.toThrow(
      /getUpdates failed: malformed response body/,
    );
  });
});

// ---------------------------------------------------------------------------
// askLog
// ---------------------------------------------------------------------------

describe("telegram/askLog", () => {
  const savedLogEnv = process.env.MONDAY_TELEGRAM_ASK_LOG;

  afterEach(() => {
    if (savedLogEnv === undefined) delete process.env.MONDAY_TELEGRAM_ASK_LOG;
    else process.env.MONDAY_TELEGRAM_ASK_LOG = savedLogEnv;
  });

  it("env override path receives exactly one JSON line; question text never stored", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-tg-log-"));
    const logPath = path.join(dir, "asks.jsonl");
    process.env.MONDAY_TELEGRAM_ASK_LOG = logPath;

    recordAsk(
      { chatId: 4242, questionLen: 21, cited: true, latencyMs: 12 },
      undefined,
      () => new Date(FIXED_CLOCK_MS), // pinned clock — the "4242" scan is deterministic
    );

    const raw = fs.readFileSync(logPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trim().split("\n").length).toBe(1);
    const entry = JSON.parse(raw.trim());
    expect(Object.keys(entry).sort()).toEqual(["chatHash", "cited", "latencyMs", "questionLen", "ts"]);
    expect(entry.chatHash).toMatch(/^[0-9a-f]{12}$/);
    expect(raw).not.toContain("4242");
  });

  it("unwritable path is swallowed (never throws)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-tg-log-"));
    expect(() =>
      recordAsk({ chatId: 42, questionLen: 5, cited: false, latencyMs: 0 }, dir),
    ).not.toThrow(); // dir itself as target → EISDIR → swallowed
  });
});
