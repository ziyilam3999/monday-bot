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

describe("slack/adapter — label-aware /ask augment (#1386)", () => {
  type Block = { type: string; text?: { text: string } };

  /** Abstain knowledge service: citation-free NO_CONTEXT-style answer. */
  function abstainKnowledge(): AnswerProvider & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async query(question: string) {
        calls.push(question);
        return {
          answer: "I could not find anything about that in the indexed docs.",
          citations: [],
        };
      },
    };
  }

  const DEFECTS = [
    { key: "DEMO-1", summary: "synthetic crash" },
    { key: "DEMO-2", summary: "another synthetic issue" },
  ];
  const augmentReturning = (issues = DEFECTS) => async () => ({ jql: "JQL-X", issues });

  /** Capture the blocks an /ask reply produced for a given adapter + question. */
  async function askBlocks(adapter: SlackAdapter, text: string): Promise<Block[]> {
    const fakeApp = adapter._getApp() as unknown as {
      _triggerCommand(name: string, cmd: unknown): Promise<void>;
      _respondMessages: Array<{ blocks?: Block[]; text: string }>;
    };
    await fakeApp._triggerCommand("/ask", { text });
    return fakeApp._respondMessages[fakeApp._respondMessages.length - 1].blocks ?? [];
  }

  it("citation-numbering-unperturbed: doc blocks are a byte-identical PREFIX, defects appended at END", async () => {
    const question = "tell me about the widget";
    // Reference: same adapter WITHOUT askAugment.
    const refBlocks = await askBlocks(
      new SlackAdapter({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        knowledgeService: fakeKnowledge(),
      }),
      question,
    );

    const withAug = await askBlocks(
      new SlackAdapter({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        knowledgeService: fakeKnowledge(),
        askAugment: augmentReturning(),
      }),
      question,
    );

    // The doc answer + citation list are an UNCHANGED prefix.
    expect(withAug.slice(0, refBlocks.length)).toEqual(refBlocks);
    // The defects ride at the END: divider + section.
    const appended = withAug.slice(refBlocks.length);
    expect(appended[0]).toEqual({ type: "divider" });
    expect(appended[1].type).toBe("section");
    expect(appended[1].text!.text).toContain("Related tracked defects");
    expect(appended[1].text!.text).toContain("• DEMO-1 — synthetic crash");
    // The citation marker [1] survives untouched in the prefix.
    const joined = refBlocks.map((b) => b.text?.text ?? "").join("\n");
    expect(joined).toMatch(/\[1\]/);
  });

  it("no askAugment ⇒ identical-to-today reply blocks", async () => {
    const question = "tell me about the widget";
    const a = await askBlocks(
      new SlackAdapter({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        knowledgeService: fakeKnowledge(),
      }),
      question,
    );
    // No divider/section beyond the doc answer + citation context.
    expect(a.filter((b) => b.text?.text?.includes("Related tracked defects"))).toHaveLength(0);
  });

  it("augment throws/returns null ⇒ reply unchanged (no crash, no extra blocks)", async () => {
    const question = "tell me about the widget";
    const refBlocks = await askBlocks(
      new SlackAdapter({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        knowledgeService: fakeKnowledge(),
      }),
      question,
    );
    const thrown = await askBlocks(
      new SlackAdapter({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        knowledgeService: fakeKnowledge(),
        askAugment: async () => {
          throw new Error("augment boom");
        },
      }),
      question,
    );
    expect(thrown).toEqual(refBlocks);
  });

  it("abstain-still-clean (no area): abstain payload unchanged, no defects section", async () => {
    const blocks = await askBlocks(
      new SlackAdapter({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        knowledgeService: abstainKnowledge(),
        askAugment: async () => null,
      }),
      "something totally unknown",
    );
    // Citation-free abstain: a single section, no divider, no defects.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text!.text).not.toContain("Related tracked defects");
    expect(blocks.map((b) => b.text?.text ?? "").join("\n")).not.toMatch(/\[\d+\]/);
  });

  it("R3 — abstain-but-area-matched surfaces defects (abstain text UNCHANGED, marker-free)", async () => {
    const ks = abstainKnowledge();
    const refBlocks = await askBlocks(
      new SlackAdapter({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        knowledgeService: abstainKnowledge(),
      }),
      "tell me about the widget",
    );
    const blocks = await askBlocks(
      new SlackAdapter({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        knowledgeService: ks,
        askAugment: augmentReturning(),
      }),
      "tell me about the widget",
    );
    // The abstain blocks are an UNCHANGED prefix (still citation-free).
    expect(blocks.slice(0, refBlocks.length)).toEqual(refBlocks);
    expect(refBlocks.map((b) => b.text?.text ?? "").join("\n")).not.toMatch(/\[\d+\]/);
    // Defects ARE appended on the doc-abstain.
    const appended = blocks.slice(refBlocks.length);
    expect(appended[0]).toEqual({ type: "divider" });
    expect(appended[1].text!.text).toContain("Related tracked defects");
  });

  it("app_mention DOC branch also appends the defects section", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      knowledgeService: fakeKnowledge(),
      askAugment: augmentReturning(),
    });
    const fakeApp = adapter._getApp() as unknown as {
      _triggerEvent(name: string, ev: unknown): Promise<void>;
      _postMessages: Array<{ blocks?: Block[] }>;
    };
    await fakeApp._triggerEvent("app_mention", {
      text: "<@U12345> tell me about the widget",
      channel: "C123",
      ts: "1700000000.000900",
    });
    const blocks = fakeApp._postMessages[0].blocks ?? [];
    const hasDefects = blocks.some((b) => b.text?.text?.includes("Related tracked defects"));
    expect(hasDefects).toBe(true);
  });
});
