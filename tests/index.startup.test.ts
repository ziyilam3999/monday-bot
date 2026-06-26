import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runMonday } from "../src/index";
import { MissingEnvVarError } from "../src/config/env";

const BOT_TOKEN = "bot-token-test-value";
const APP_TOKEN = "app-token-test-value";

function makeTempConfigYaml(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-startup-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

describe("runMonday — startup wiring (AC-4, regression for AC-04)", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
      SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
      MONDAY_TEST_MODE: process.env.MONDAY_TEST_MODE,
      MONDAY_DEBUG: process.env.MONDAY_DEBUG,
    };
  });

  afterEach(() => {
    for (const k of Object.keys(savedEnv)) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("instantiates SlackAdapter and resolves adapter.start() with valid env (jest auto-stubbed Bolt)", async () => {
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
    const cfg = makeTempConfigYaml("indexPath: ./tmp/index\n");

    const handle = await runMonday({ configPath: cfg, exitOnError: false });

    expect(handle.adapter).toBeDefined();
    expect(handle.knowledge).toBeDefined();
    expect(typeof handle.shutdown).toBe("function");

    const fakeApp = handle.adapter._getApp() as unknown as {
      _started: boolean;
      _eventHandlers: Map<string, unknown>;
    };
    expect(fakeApp._started).toBe(true);
    expect(fakeApp._eventHandlers.has("app_mention")).toBe(true);

    await handle.shutdown();
  });

  it("shutdown() stops the Slack adapter (SIGTERM equivalent)", async () => {
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
    const cfg = makeTempConfigYaml("indexPath: ./tmp/index\n");

    const handle = await runMonday({ configPath: cfg, exitOnError: false });

    const fakeApp = handle.adapter._getApp() as unknown as { _stopped: boolean };
    expect(fakeApp._stopped).toBe(false);

    await handle.shutdown();

    expect(fakeApp._stopped).toBe(true);
  });

  it("missing SLACK_BOT_TOKEN throws MissingEnvVarError when exitOnError is false (AC-04 regression coverage)", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
    const cfg = makeTempConfigYaml("indexPath: ./tmp/index\n");

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runMonday({ configPath: cfg, exitOnError: false })).rejects.toBeInstanceOf(
      MissingEnvVarError,
    );
    const printed = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain("Monday cannot start");
    expect(printed).toContain("SLACK_BOT_TOKEN");
    errSpy.mockRestore();
  });
});

describe("recordFeedbackToSink — durable feedback file sink", () => {
  it("writes a line to MONDAY_FEEDBACK_LOG AND echoes a [feedback] stdout line", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { recordFeedbackToSink } = require("../src/index") as typeof import("../src/index");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-feedback-"));
    const logPath = path.join(dir, "feedback.log");
    const saved = process.env.MONDAY_FEEDBACK_LOG;
    process.env.MONDAY_FEEDBACK_LOG = logPath;
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      recordFeedbackToSink("VPN answer was wrong");
      const contents = fs.readFileSync(logPath, "utf8");
      expect(contents).toContain("VPN answer was wrong");
      const printed = logSpy.mock.calls.map((c) => String(c[0]));
      expect(printed.some((l) => l.includes("[feedback] VPN answer was wrong"))).toBe(true);
    } finally {
      logSpy.mockRestore();
      if (saved === undefined) delete process.env.MONDAY_FEEDBACK_LOG;
      else process.env.MONDAY_FEEDBACK_LOG = saved;
    }
  });

  it("never throws when the log path is unwritable", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { recordFeedbackToSink } = require("../src/index") as typeof import("../src/index");
    const saved = process.env.MONDAY_FEEDBACK_LOG;
    // A path whose parent is an existing FILE (not a dir) → mkdir/append fail.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-feedback-bad-"));
    const fileAsParent = path.join(dir, "afile");
    fs.writeFileSync(fileAsParent, "x", "utf8");
    process.env.MONDAY_FEEDBACK_LOG = path.join(fileAsParent, "nested", "feedback.log");
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(() => recordFeedbackToSink("should not throw")).not.toThrow();
    } finally {
      logSpy.mockRestore();
      if (saved === undefined) delete process.env.MONDAY_FEEDBACK_LOG;
      else process.env.MONDAY_FEEDBACK_LOG = saved;
    }
  });
});
