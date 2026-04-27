import {
  commandHandlers,
  statusCommand,
  syncConfluenceCommand,
  reindexCommand,
  helpCommand,
  feedbackCommand,
  AdminService,
} from "../src/slack/commands";

function makeStatusService(overrides: Partial<AdminService> = {}): AdminService {
  return {
    getStatus: () => ({
      documentCount: 42,
      watcherAlive: true,
      uptimeSeconds: 3661, // 1h 1m 1s
    }),
    ...overrides,
  };
}

describe("slack/commands — registry shape", () => {
  it("exports a record covering status, sync, reindex, help, feedback", () => {
    const keys = Object.keys(commandHandlers).map((k) => k.toLowerCase());
    for (const required of ["status", "sync", "reindex", "help", "feedback"]) {
      expect(keys.some((k) => k.includes(required))).toBe(true);
    }
  });

  it("every handler is a function", () => {
    for (const handler of Object.values(commandHandlers)) {
      expect(typeof handler).toBe("function");
    }
  });
});

describe("slack/commands — status", () => {
  it("returns a string containing doc count, watcher status, and uptime", () => {
    const result = statusCommand(makeStatusService());
    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toContain("42");
    expect(text).toMatch(/alive|true|active|yes/i);
    expect(text).toMatch(/uptime|[0-9]+\s*(s|sec|m|min|h|hr)/i);
  });

  it("uses 'stopped' wording when the watcher is not alive", () => {
    const result = statusCommand(
      makeStatusService({
        getStatus: () => ({ documentCount: 0, watcherAlive: false, uptimeSeconds: 5 }),
      }),
    );
    expect(typeof result).toBe("string");
    expect((result as string).toLowerCase()).toContain("stopped");
  });

  it("degrades gracefully when service has no getStatus", () => {
    const result = statusCommand({} as AdminService);
    expect(typeof result).toBe("string");
    expect((result as string)).toContain("0");
  });
});

describe("slack/commands — sync-confluence", () => {
  it("calls service.syncConfluence and returns its message", async () => {
    const calls: Array<string | undefined> = [];
    const service: AdminService = {
      syncConfluence: async (key) => {
        calls.push(key);
        return "Synced 12 pages";
      },
    };
    const result = await syncConfluenceCommand(service, "ENG");
    expect(calls).toEqual(["ENG"]);
    expect(result).toBe("Synced 12 pages");
  });

  it("returns a default success message when service returns void", async () => {
    const service: AdminService = { syncConfluence: async () => undefined };
    const result = await syncConfluenceCommand(service);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeGreaterThan(0);
  });

  it("returns a 'not configured' string when service has no syncConfluence", async () => {
    const result = await syncConfluenceCommand({} as AdminService);
    expect((result as string).toLowerCase()).toContain("not configured");
  });

  it("catches sync failures and returns a friendly error string", async () => {
    const service: AdminService = {
      syncConfluence: async () => {
        throw new Error("network down");
      },
    };
    const result = await syncConfluenceCommand(service);
    expect((result as string).toLowerCase()).toContain("failed");
    expect((result as string)).toContain("network down");
  });
});

describe("slack/commands — reindex", () => {
  it("calls service.reindex and surfaces its message", async () => {
    let called = false;
    const service: AdminService = {
      reindex: async () => {
        called = true;
        return "rebuilt 99 chunks";
      },
    };
    const result = await reindexCommand(service);
    expect(called).toBe(true);
    expect(result).toBe("rebuilt 99 chunks");
  });

  it("returns a 'not configured' string when reindex is missing", async () => {
    const result = await reindexCommand({} as AdminService);
    expect((result as string).toLowerCase()).toContain("not configured");
  });

  it("catches reindex failures", async () => {
    const service: AdminService = {
      reindex: async () => {
        throw new Error("disk full");
      },
    };
    const result = await reindexCommand(service);
    expect((result as string).toLowerCase()).toContain("failed");
    expect(result as string).toContain("disk full");
  });
});

describe("slack/commands — help", () => {
  it("returns a non-empty string listing the admin commands", () => {
    const result = helpCommand({} as AdminService);
    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text.length).toBeGreaterThan(20);
    for (const cmd of ["status", "sync", "reindex", "help", "feedback", "ask"]) {
      expect(text.toLowerCase()).toContain(cmd);
    }
  });
});

describe("slack/commands — feedback", () => {
  it("returns a confirmation string and forwards to recordFeedback", () => {
    const recorded: string[] = [];
    const service: AdminService = { recordFeedback: (msg) => void recorded.push(msg) };
    const result = feedbackCommand(service, "VPN answer was wrong");
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeGreaterThan(2);
    expect(recorded).toEqual(["VPN answer was wrong"]);
  });

  it("falls back to console.log when service has no recordFeedback", () => {
    const original = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      const result = feedbackCommand({} as AdminService, "Slack adapter fell over");
      expect((result as string).length).toBeGreaterThan(2);
      expect(captured.some((line) => line.includes("Slack adapter fell over"))).toBe(true);
    } finally {
      console.log = original;
    }
  });

  it("returns a usage hint when message is empty", () => {
    const result = feedbackCommand({} as AdminService, "");
    expect((result as string).toLowerCase()).toContain("usage");
  });

  it("never throws when recordFeedback throws", () => {
    const service: AdminService = {
      recordFeedback: () => {
        throw new Error("logging broke");
      },
    };
    expect(() => feedbackCommand(service, "still want to say this")).not.toThrow();
  });
});
