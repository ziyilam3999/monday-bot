import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runMonday } from "../src/index";
import { MissingEnvVarError } from "../src/config/env";
import * as knowledgeModule from "../src/knowledge/service";

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
    const cfg = makeTempConfigYaml("watchedFolders: []\n");

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

  it("shutdown() stops the Slack adapter and folder watchers (SIGTERM equivalent)", async () => {
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
    const cfg = makeTempConfigYaml("watchedFolders: []\n");

    const handle = await runMonday({ configPath: cfg, exitOnError: false });

    const fakeApp = handle.adapter._getApp() as unknown as { _stopped: boolean };
    expect(fakeApp._stopped).toBe(false);

    const stopWatchingSpy = jest.spyOn(handle.knowledge, "stopWatching");
    await handle.shutdown();

    expect(fakeApp._stopped).toBe(true);
    expect(stopWatchingSpy).toHaveBeenCalledTimes(1);
  });

  it("missing SLACK_BOT_TOKEN throws MissingEnvVarError when exitOnError is false (AC-04 regression coverage)", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
    const cfg = makeTempConfigYaml("watchedFolders: []\n");

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

describe("runMonday — folder watcher attachment (AC-5)", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
      SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
    };
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
  });

  afterEach(() => {
    for (const k of Object.keys(savedEnv)) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("calls knowledge.watchFolder once per entry in config.watchedFolders", async () => {
    const folderA = fs.mkdtempSync(path.join(os.tmpdir(), "monday-folder-a-"));
    const folderB = fs.mkdtempSync(path.join(os.tmpdir(), "monday-folder-b-"));
    const cfg = makeTempConfigYaml(
      `watchedFolders:\n  - ${folderA}\n  - ${folderB}\n`,
    );

    const watchSpy = jest.spyOn(knowledgeModule.KnowledgeService.prototype, "watchFolder");

    const handle = await runMonday({ configPath: cfg, exitOnError: false });

    const watchedDirs = watchSpy.mock.calls.map((c) => c[0]);
    expect(watchedDirs).toContain(folderA);
    expect(watchedDirs).toContain(folderB);
    expect(watchSpy).toHaveBeenCalledTimes(2);

    await handle.shutdown();
    watchSpy.mockRestore();
  });

  it("nullish-coalesces watchedFolders to [] when undefined (no watchFolder calls)", async () => {
    const cfg = makeTempConfigYaml("indexPath: ./tmp/index\n");

    const watchSpy = jest.spyOn(knowledgeModule.KnowledgeService.prototype, "watchFolder");

    const handle = await runMonday({ configPath: cfg, exitOnError: false });

    expect(watchSpy).not.toHaveBeenCalled();

    await handle.shutdown();
    watchSpy.mockRestore();
  });

  it("logs and continues when watchFolder throws (one bad folder doesn't kill the bot)", async () => {
    const goodFolder = fs.mkdtempSync(path.join(os.tmpdir(), "monday-good-"));
    const cfg = makeTempConfigYaml(
      `watchedFolders:\n  - /nonexistent/path/that/will/throw\n  - ${goodFolder}\n`,
    );

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const watchSpy = jest
      .spyOn(knowledgeModule.KnowledgeService.prototype, "watchFolder")
      .mockImplementationOnce(() => {
        throw new Error("simulated watch failure");
      });

    const handle = await runMonday({ configPath: cfg, exitOnError: false });

    // Adapter still came up despite first watcher throwing.
    const fakeApp = handle.adapter._getApp() as unknown as { _started: boolean };
    expect(fakeApp._started).toBe(true);

    const printed = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain("failed to watch folder");

    await handle.shutdown();
    watchSpy.mockRestore();
    errSpy.mockRestore();
  });
});
