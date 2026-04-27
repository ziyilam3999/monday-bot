import { SlackAdapter, SlackConfigError, AnswerProvider } from "../src/slack/adapter";

function fakeKnowledge(): AnswerProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(question: string) {
      calls.push(question);
      return {
        answer: `Answer for: ${question} [1]`,
        citations: [{ num: 1, source: "doc-a.md" }],
      };
    },
  };
}

describe("slack/adapter — config validation", () => {
  it("throws SlackConfigError on empty botToken", () => {
    expect(
      () =>
        new SlackAdapter({
          botToken: "",
          appToken: "xapp-1",
          knowledgeService: fakeKnowledge(),
        }),
    ).toThrow(SlackConfigError);
  });

  it("throws SlackConfigError on empty appToken", () => {
    expect(
      () =>
        new SlackAdapter({
          botToken: "xoxb-1",
          appToken: "",
          knowledgeService: fakeKnowledge(),
        }),
    ).toThrow(SlackConfigError);
  });

  it("throws SlackConfigError when knowledgeService is null", () => {
    expect(
      () =>
        new SlackAdapter({
          botToken: "xoxb-1",
          appToken: "xapp-1",
          knowledgeService: null,
        }),
    ).toThrow(SlackConfigError);
  });

  it("throws SlackConfigError when knowledgeService has no query method", () => {
    expect(
      () =>
        new SlackAdapter({
          botToken: "xoxb-1",
          appToken: "xapp-1",
          knowledgeService: {} as never,
        }),
    ).toThrow(SlackConfigError);
  });

  it("error message mentions the missing field", () => {
    try {
      new SlackAdapter({
        botToken: "",
        appToken: "xapp-1",
        knowledgeService: fakeKnowledge(),
      });
      fail("expected throw");
    } catch (e) {
      expect((e as Error).message.toLowerCase()).toContain("token");
    }
  });
});

describe("slack/adapter — handler registration & dispatch", () => {
  it("registers app_mention and /ask handlers without throwing", () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: fakeKnowledge(),
    });
    const fakeApp = adapter._getApp() as unknown as {
      _eventHandlers: Map<string, unknown>;
      _commandHandlers: Map<string, unknown>;
    };
    expect(fakeApp._eventHandlers.has("app_mention")).toBe(true);
    expect(fakeApp._commandHandlers.has("/ask")).toBe(true);
  });

  it("app_mention strips the leading mention and queries the knowledge service", async () => {
    const ks = fakeKnowledge();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: ks,
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerEvent(name: string, ev: unknown): Promise<void>;
      _postMessages: Array<{ channel: string; text: string; blocks?: unknown[]; thread_ts?: string }>;
    };
    await fakeApp._triggerEvent("app_mention", {
      text: "<@U12345> how many days of leave?",
      channel: "C123",
      ts: "1700000000.000100",
    });
    expect(ks.calls).toEqual(["how many days of leave?"]);
    expect(fakeApp._postMessages.length).toBe(1);
    const msg = fakeApp._postMessages[0];
    expect(msg.channel).toBe("C123");
    expect(msg.thread_ts).toBe("1700000000.000100");
    expect(Array.isArray(msg.blocks)).toBe(true);
    expect(JSON.stringify(msg)).toContain("doc-a.md");
  });

  it("app_mention with empty question posts a help message and skips the knowledge service", async () => {
    const ks = fakeKnowledge();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: ks,
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerEvent(name: string, ev: unknown): Promise<void>;
      _postMessages: Array<{ text: string }>;
    };
    await fakeApp._triggerEvent("app_mention", {
      text: "<@U12345>   ",
      channel: "C123",
      ts: "1700000000.000200",
    });
    expect(ks.calls).toEqual([]);
    expect(fakeApp._postMessages.length).toBe(1);
    expect(fakeApp._postMessages[0].text.toLowerCase()).toContain("ask me");
  });

  it("/ask acks, queries, and responds ephemerally", async () => {
    const ks = fakeKnowledge();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: ks,
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerCommand(name: string, cmd: unknown): Promise<void>;
      _ackCalls: number;
      _respondMessages: Array<{ response_type: string; text: string; blocks?: unknown[] }>;
    };
    await fakeApp._triggerCommand("/ask", { text: "what is the wifi password?" });
    expect(fakeApp._ackCalls).toBe(1);
    expect(ks.calls).toEqual(["what is the wifi password?"]);
    expect(fakeApp._respondMessages.length).toBe(1);
    expect(fakeApp._respondMessages[0].response_type).toBe("ephemeral");
    expect(Array.isArray(fakeApp._respondMessages[0].blocks)).toBe(true);
  });

  it("/ask with empty text returns usage hint and does not query", async () => {
    const ks = fakeKnowledge();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: ks,
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerCommand(name: string, cmd: unknown): Promise<void>;
      _respondMessages: Array<{ text: string }>;
    };
    await fakeApp._triggerCommand("/ask", { text: "   " });
    expect(ks.calls).toEqual([]);
    expect(fakeApp._respondMessages[0].text.toLowerCase()).toContain("usage");
  });

  it("posts a fallback message when the knowledge service throws", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: {
        async query() {
          throw new Error("boom");
        },
      },
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerEvent(name: string, ev: unknown): Promise<void>;
      _postMessages: Array<{ text: string }>;
    };
    await fakeApp._triggerEvent("app_mention", {
      text: "<@U12345> question",
      channel: "C123",
      ts: "1700000000.000300",
    });
    expect(fakeApp._postMessages.length).toBe(1);
    expect(fakeApp._postMessages[0].text.toLowerCase()).toMatch(/error|sorry/);
  });
});

describe("slack/adapter — start/stop", () => {
  it("start() and stop() delegate to the underlying app", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: fakeKnowledge(),
    });
    await adapter.start();
    await adapter.stop();
    const fakeApp = adapter._getApp() as unknown as { _started: boolean; _stopped: boolean };
    expect(fakeApp._started).toBe(true);
    expect(fakeApp._stopped).toBe(true);
  });
});
