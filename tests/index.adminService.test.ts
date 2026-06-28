/**
 * Production-wiring test (#1346): the `adminService` that `runMonday` builds now
 * exposes `answerJql`, so the Slack `/jql` command is actually wired. Zero-network:
 * with NO Atlassian creds in env, `answerJql` short-circuits to the graceful
 * "not configured" reply before any fetcher is built — exercising the real
 * production code path (`buildAnswerJql({ env: process.env })`) end-to-end through
 * `runMonday` with no real Slack/Jira.
 *
 * NOTE: this file never references any Atlassian sandbox host literal — it deletes
 * the Atlassian creds rather than setting them — so the AC9 privacy grep stays clean.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runMonday } from "../src/index";

const BOT_TOKEN = "bot-token-test-value";
const APP_TOKEN = "app-token-test-value";

function makeTempConfigYaml(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-adminsvc-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

describe("runMonday — adminService.answerJql wiring (#1346)", () => {
  let savedEnv: Record<string, string | undefined>;
  const CRED_KEYS = [
    "CONFLUENCE_URL",
    "CONFLUENCE_BASE_URL",
    "CONFLUENCE_EMAIL",
    "CONFLUENCE_API_TOKEN",
  ];

  beforeEach(() => {
    savedEnv = {
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
      SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
      MONDAY_TEST_MODE: process.env.MONDAY_TEST_MODE,
    };
    for (const k of CRED_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k]; // creds-absent → graceful zero-network path.
    }
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
    process.env.MONDAY_TEST_MODE = "1";
  });

  afterEach(() => {
    for (const k of Object.keys(savedEnv)) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("exposes answerJql on the handle's adminService and returns the graceful no-creds reply", async () => {
    const cfg = makeTempConfigYaml("indexPath: ./tmp/index\n");

    const handle = await runMonday({ configPath: cfg, exitOnError: false });

    expect(typeof handle.adminService.answerJql).toBe("function");
    const reply = await handle.adminService.answerJql!("show me crashes");
    expect(reply).toEqual({
      jql: "",
      issues: [],
      warnings: ["Jira credentials are not configured."],
    });

    await handle.shutdown();
  });
});
