/**
 * #3277 — runMonday wiring gate for the Telegram adapter. All tests use a
 * gated fake transport (never-settling steady polls — zero network, zero spin)
 * and an explicit appFactory so MONDAY_TEST_MODE's auto-exit path stays off.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runMonday } from "../src/index";
import { TelegramTransport, TgUpdate } from "../src/telegram/transport";
import type { AppFactory } from "../src/slack/adapter";

const BOT_TOKEN = "bot-token-test-value";
const APP_TOKEN = "app-token-test-value";
const TG_TOKEN = "tg-token-1";

function makeTempConfigYaml(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-tg-startup-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, "indexPath: ./tmp/index\n", "utf8");
  return file;
}

/** Explicit fake Bolt App factory — keeps MONDAY_TEST_MODE's auto-exit off. */
const fakeAppFactory: AppFactory = (() =>
  ({
    event: () => undefined,
    command: () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
  }) as never) as AppFactory;

/**
 * Gated transport: every getUpdates blocks until release() — the steady loop
 * can never spin, and the test observes exactly which polls happened.
 */
class GateTransport implements TelegramTransport {
  calls: Array<{ offset: number; timeout: number }> = [];
  sendMessageCalls: number = 0;
  private waiters: Array<() => void> = [];

  async getUpdates(offset: number, timeout: number): Promise<TgUpdate[]> {
    this.calls.push({ offset, timeout });
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return [];
  }

  async sendMessage(): Promise<unknown> {
    this.sendMessageCalls += 1;
    return { ok: true };
  }

  release(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  async waitForCalls(n: number): Promise<void> {
    while (this.calls.length < n) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("runMonday — Telegram wiring gate (#3277)", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
      SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
      MONDAY_TEST_MODE: process.env.MONDAY_TEST_MODE,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_ALLOWED_CHAT_IDS: process.env.TELEGRAM_ALLOWED_CHAT_IDS,
    };
  });

  afterEach(() => {
    for (const k of Object.keys(savedEnv)) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("AC6/AC15 — TELEGRAM_BOT_TOKEN unset → resolves Slack-only, transport factory spy never invoked", async () => {
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
    process.env.MONDAY_TEST_MODE = "1";
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;

    const spy = jest.fn<never, []>();
    const handle = await runMonday({
      configPath: makeTempConfigYaml(),
      exitOnError: false,
      appFactory: fakeAppFactory,
      telegramTransportFactory: spy,
    });

    expect(handle.adapter).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
    await handle.shutdown();
  });

  it("AC6 — token set + allow-list unset → startup rejects (fail closed)", async () => {
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
    process.env.MONDAY_TEST_MODE = "1";
    process.env.TELEGRAM_BOT_TOKEN = TG_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runMonday({
        configPath: makeTempConfigYaml(),
        exitOnError: false,
        appFactory: fakeAppFactory,
        telegramTransportFactory: () => new GateTransport(),
      }),
    ).rejects.toThrow(/TELEGRAM_ALLOWED_CHAT_IDS/);
    errSpy.mockRestore();
  });

  it("token set + valid list → Telegram starts (drain + steady poll) and shutdown() stops it", async () => {
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
    process.env.MONDAY_TEST_MODE = "1";
    process.env.TELEGRAM_BOT_TOKEN = TG_TOKEN;
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = "42";

    const transport = new GateTransport();
    const runPromise = runMonday({
      configPath: makeTempConfigYaml(),
      exitOnError: false,
      appFactory: fakeAppFactory,
      telegramTransportFactory: () => transport,
    });

    await transport.waitForCalls(1); // boot drain
    expect(transport.calls[0]).toEqual({ offset: -1, timeout: 0 });
    transport.release(); // empty queue → offset 0

    const handle = await runPromise;
    await transport.waitForCalls(2); // first steady poll
    expect(transport.calls[1]).toEqual({ offset: 0, timeout: 25 });
    transport.release();

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const before = transport.calls.length; // third poll pending (gated)
    expect(before).toBeGreaterThanOrEqual(2);

    await handle.shutdown(); // stops Telegram + Slack
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(transport.calls.length).toBe(before); // stable across a settling tick
  });
});
