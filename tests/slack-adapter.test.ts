import { SlackAdapter, SlackConfigError, AnswerProvider } from "../src/slack/adapter";
import { AdminService } from "../src/slack/commands";

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

describe("slack/adapter — admin commands wired through adminService", () => {
  it("/sync-confluence + /reindex route to the adminService and surface its summary", async () => {
    const syncArgs: Array<string | undefined> = [];
    const adminService = {
      syncConfluence: async (spaceKey?: string) => {
        syncArgs.push(spaceKey);
        return "Re-synced confluence: DEMO (2 pages)";
      },
      reindex: async () => "Reindexed: confluence 2 pages",
    };
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: fakeKnowledge(),
      adminService,
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerCommand(name: string, cmd: unknown): Promise<void>;
      _ackCalls: number;
      _respondMessages: Array<{ response_type: string; text: string }>;
    };

    await fakeApp._triggerCommand("/sync-confluence", { text: "" });
    expect(fakeApp._ackCalls).toBe(1);
    expect(fakeApp._respondMessages[0].text).toContain("Re-synced confluence: DEMO (2 pages)");
    expect(fakeApp._respondMessages[0].text.toLowerCase()).not.toContain("not configured");

    await fakeApp._triggerCommand("/reindex", {});
    expect(fakeApp._ackCalls).toBe(2);
    expect(fakeApp._respondMessages[1].text).toContain("Reindexed: confluence 2 pages");
    expect(fakeApp._respondMessages[1].text.toLowerCase()).not.toContain("not configured");
  });

  it("/sync-confluence forwards the space argument to adminService.syncConfluence", async () => {
    const syncArgs: Array<string | undefined> = [];
    const adminService = {
      syncConfluence: async (spaceKey?: string) => {
        syncArgs.push(spaceKey);
        return `Re-synced confluence: ${spaceKey} (1 pages)`;
      },
    };
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: fakeKnowledge(),
      adminService,
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerCommand(name: string, cmd: unknown): Promise<void>;
      _respondMessages: Array<{ text: string }>;
    };

    await fakeApp._triggerCommand("/sync-confluence", { text: "DEMO" });
    expect(syncArgs).toEqual(["DEMO"]);
    expect(fakeApp._respondMessages[0].text).toContain("DEMO");
  });

  it("back-compat: NO adminService → /reindex hits the default 'not configured' guard", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      // knowledgeService has only query() — no admin methods, so the default
      // adminService (= knowledgeService) exposes no reindex().
      knowledgeService: fakeKnowledge(),
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerCommand(name: string, cmd: unknown): Promise<void>;
      _respondMessages: Array<{ text: string }>;
    };

    await fakeApp._triggerCommand("/reindex", {});
    expect(fakeApp._respondMessages[0].text.toLowerCase()).toContain("not configured");
  });
});

describe("slack/adapter — app_mention defect routing (#1344)", () => {
  const JQL = 'labels in ("mb-symptom-crash-error") AND statusCategory != Done';

  function fakeAdmin(): AdminService & { jqlCalls: string[] } {
    const jqlCalls: string[] = [];
    return {
      jqlCalls,
      async answerJql(question: string) {
        jqlCalls.push(question);
        return {
          jql: JQL,
          issues: [
            { key: "DEMO-1", summary: "checkout boom" },
            { key: "DEMO-2", summary: "another crash" },
          ],
        };
      },
    };
  }

  it("AC5: a DEFECT mention routes to answerJql, posts JQL-first in-thread, and does NOT query the knowledge service", async () => {
    const ks = fakeKnowledge();
    const admin = fakeAdmin();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: ks,
      adminService: admin,
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerEvent(name: string, ev: unknown): Promise<void>;
      _postMessages: Array<{ channel: string; text: string; blocks?: unknown[]; thread_ts?: string }>;
    };
    await fakeApp._triggerEvent("app_mention", {
      text: "<@U12345> show me the crashes",
      channel: "C123",
      ts: "1700000000.000500",
    });
    // answerJql received the cleaned question; the doc path was NOT taken.
    expect(admin.jqlCalls).toEqual(["show me the crashes"]);
    expect(ks.calls).toEqual([]);
    expect(fakeApp._postMessages.length).toBe(1);
    const msg = fakeApp._postMessages[0];
    expect(msg.channel).toBe("C123");
    expect(msg.thread_ts).toBe("1700000000.000500");
    // JQL-first: the *JQL:* header + the JQL appear BEFORE the first defect key.
    expect(msg.text).toContain("*JQL:*");
    expect(msg.text.indexOf(JQL)).toBeGreaterThanOrEqual(0);
    expect(msg.text.indexOf(JQL)).toBeLessThan(msg.text.indexOf("DEMO-1"));
    // The JQL reply is a plain string (no blocks), matching the /jql slash reply.
    expect(msg.blocks).toBeUndefined();
  });

  it("AC6: a DOC mention still queries the knowledge service and posts a blocks payload (unchanged)", async () => {
    const ks = fakeKnowledge();
    const admin = fakeAdmin();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: ks,
      adminService: admin,
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerEvent(name: string, ev: unknown): Promise<void>;
      _postMessages: Array<{ text: string; blocks?: unknown[] }>;
    };
    await fakeApp._triggerEvent("app_mention", {
      text: "<@U12345> how many days of leave?",
      channel: "C123",
      ts: "1700000000.000600",
    });
    expect(ks.calls).toEqual(["how many days of leave?"]);
    expect(admin.jqlCalls).toEqual([]);
    expect(fakeApp._postMessages.length).toBe(1);
    expect(Array.isArray(fakeApp._postMessages[0].blocks)).toBe(true);
  });

  it("AC7: an EMPTY mention still posts the greeting and calls NEITHER answerJql NOR query", async () => {
    const ks = fakeKnowledge();
    const admin = fakeAdmin();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: ks,
      adminService: admin,
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerEvent(name: string, ev: unknown): Promise<void>;
      _postMessages: Array<{ text: string }>;
    };
    await fakeApp._triggerEvent("app_mention", {
      text: "<@U12345>   ",
      channel: "C123",
      ts: "1700000000.000700",
    });
    expect(ks.calls).toEqual([]);
    expect(admin.jqlCalls).toEqual([]);
    expect(fakeApp._postMessages.length).toBe(1);
    expect(fakeApp._postMessages[0].text.toLowerCase()).toContain("ask me");
  });

  it("AC8: /jql stays registered as an admin command (slash behaviour unchanged)", () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: fakeKnowledge(),
      adminService: fakeAdmin(),
    });
    const fakeApp = adapter._getApp() as unknown as {
      _commandHandlers: Map<string, unknown>;
    };
    expect(fakeApp._commandHandlers.has("/jql")).toBe(true);
  });

  it("AC12: a DEFECT mention with NO answerJql posts the 'not configured' string in-thread and does NOT query", async () => {
    const ks = fakeKnowledge();
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      // No adminService → defaults to knowledgeService, which has no answerJql.
      knowledgeService: ks,
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerEvent(name: string, ev: unknown): Promise<void>;
      _postMessages: Array<{ text: string; thread_ts?: string }>;
    };
    await fakeApp._triggerEvent("app_mention", {
      text: "<@U12345> show me the crashes",
      channel: "C123",
      ts: "1700000000.000800",
    });
    // Routing decided without any Jira creds; degraded safely to a string.
    expect(ks.calls).toEqual([]);
    expect(fakeApp._postMessages.length).toBe(1);
    expect(fakeApp._postMessages[0].text.toLowerCase()).toContain("not configured");
    expect(fakeApp._postMessages[0].thread_ts).toBe("1700000000.000800");
  });

  it("AC12: throw-safety — a rejecting postMessage in the JQL branch does NOT escape the Bolt loop", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: fakeKnowledge(),
      adminService: fakeAdmin(),
    });
    const fakeApp = adapter._getApp() as unknown as {
      _eventHandlers: Map<string, (args: unknown) => Promise<void>>;
    };
    const handler = fakeApp._eventHandlers.get("app_mention")!;
    const errors: unknown[] = [];
    // postMessage rejects on EVERY call (primary + fallback). The handler must
    // catch it (mirroring the doc branch) and resolve without an unhandled
    // rejection — proving the new JQL branch sits inside the try/catch.
    await expect(
      handler({
        event: { text: "<@U1> show me the crashes", channel: "C1", ts: "1700000000.000900" },
        client: {
          chat: {
            postMessage: async () => {
              throw new Error("slack down");
            },
          },
        },
        logger: { error: (...a: unknown[]) => errors.push(a) },
      }),
    ).resolves.toBeUndefined();
    // The handler logged the failure rather than throwing.
    expect(errors.length).toBeGreaterThan(0);
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
