import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runMonday } from "../src/index";
import { ConfluenceFetcher, ConfluencePage } from "../src/confluence/sync";
import { JiraFetcher, JiraIssue } from "../src/jira/sync";
import { Scheduler, ScheduledTimer } from "../src/knowledge/startup";
import * as knowledgeModule from "../src/knowledge/service";

const BOT_TOKEN = "bot-token-test-value";
const APP_TOKEN = "app-token-test-value";

function makeTempConfigYaml(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-sources-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

/** A scheduler that records registrations but never starts a real timer. */
class FakeScheduler {
  readonly registrations: Array<{ ms: number }> = [];
  cleared = 0;
  readonly scheduler: Scheduler = (_cb: () => void, ms: number): ScheduledTimer => {
    this.registrations.push({ ms });
    return { clear: () => { this.cleared++; } };
  };
}

function makeFakeScheduler(): FakeScheduler {
  return new FakeScheduler();
}

const ATLASSIAN_ENV_KEYS = [
  "CONFLUENCE_URL",
  "CONFLUENCE_BASE_URL",
  "CONFLUENCE_EMAIL",
  "CONFLUENCE_API_TOKEN",
  "CONFLUENCE_SPACES",
  "JIRA_PROJECTS",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "MONDAY_TEST_MODE",
];

describe("runMonday — knowledge sources wiring (Confluence + Jira)", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ATLASSIAN_ENV_KEYS) savedEnv[k] = process.env[k];
    // Clean slate — clear all Atlassian creds so tests start deterministic.
    for (const k of ATLASSIAN_ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ATLASSIAN_ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("wires both Confluence + Jira when env + mock fetchers present; indexes docs; schedules refresh; no real timer", async () => {
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
    process.env.CONFLUENCE_URL = "https://example.atlassian.net/wiki";
    process.env.CONFLUENCE_EMAIL = "a@b.c";
    process.env.CONFLUENCE_API_TOKEN = "tok";
    process.env.CONFLUENCE_SPACES = "DEMO";
    process.env.JIRA_PROJECTS = "PROJ";

    const confluencePages: Record<string, ConfluencePage[]> = {
      DEMO: [
        { id: "c1", title: "Onboarding", body: "Welcome", source: "confluence:c1", spaceKey: "DEMO" },
      ],
    };
    const confluenceCalls: string[] = [];
    const confluenceFetcher: ConfluenceFetcher = {
      async fetchPages(spaceKey: string) {
        confluenceCalls.push(spaceKey);
        return confluencePages[spaceKey] ?? [];
      },
    };

    const jiraIssues: Record<string, JiraIssue[]> = {
      PROJ: [{ key: "PROJ-1", summary: "Bug", descriptionText: "broken", commentTexts: [] }],
    };
    const jiraCalls: string[] = [];
    const jiraFetcher: JiraFetcher = {
      async fetchIssues(projectKey: string) {
        jiraCalls.push(projectKey);
        return jiraIssues[projectKey] ?? [];
      },
    };

    const fake = makeFakeScheduler();
    const cfg = makeTempConfigYaml("watchedFolders: []\n");
    // No `logger` is passed, so `log()` falls back to console.log — spy on it to
    // assert the per-source index-count lines are emitted after initial sync.
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    const handle = await runMonday({
      configPath: cfg,
      exitOnError: false,
      confluenceFetcher,
      jiraFetcher,
      scheduler: fake.scheduler,
    });

    await handle.sources.ready;

    expect(confluenceCalls).toEqual(["DEMO"]);
    expect(jiraCalls).toEqual(["PROJ"]);
    expect(handle.knowledge.getStatus().documentCount).toBeGreaterThan(0);
    expect(handle.knowledge.getChunkCountForSource("confluence:c1")).toBe(1);
    expect(handle.knowledge.getChunkCountForSource("jira:PROJ-1")).toBe(1);

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain("confluence:DEMO indexed 1 pages");
    expect(logged).toContain("jira:PROJ indexed 1 issues");

    // One periodic refresh scheduled per source (1 space + 1 project).
    expect(fake.registrations.length).toBe(2);

    await handle.shutdown();
    expect(fake.cleared).toBe(2);
    logSpy.mockRestore();
  });

  it("comes up cleanly with NO Atlassian creds — no throw, no fetch, no scheduled timer", async () => {
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;

    const confluenceFetcher: ConfluenceFetcher = {
      async fetchPages() {
        throw new Error("should not be called");
      },
    };
    const jiraFetcher: JiraFetcher = {
      async fetchIssues() {
        throw new Error("should not be called");
      },
    };
    const fake = makeFakeScheduler();
    const cfg = makeTempConfigYaml("watchedFolders: []\n");

    const handle = await runMonday({
      configPath: cfg,
      exitOnError: false,
      confluenceFetcher,
      jiraFetcher,
      scheduler: fake.scheduler,
    });

    await handle.sources.ready;

    const fakeApp = handle.adapter._getApp() as unknown as { _started: boolean };
    expect(fakeApp._started).toBe(true);
    expect(handle.knowledge.getStatus().documentCount).toBe(0);
    expect(fake.registrations.length).toBe(0);

    await handle.shutdown();
  });

  it("initial sync failure does NOT crash startup (adapter still comes up)", async () => {
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;
    process.env.CONFLUENCE_URL = "https://example.atlassian.net/wiki";
    process.env.CONFLUENCE_EMAIL = "a@b.c";
    process.env.CONFLUENCE_API_TOKEN = "tok";
    process.env.CONFLUENCE_SPACES = "DEMO";
    process.env.JIRA_PROJECTS = "PROJ";

    const confluenceFetcher: ConfluenceFetcher = {
      async fetchPages() {
        throw new Error("confluence boom");
      },
    };
    const jiraFetcher: JiraFetcher = {
      async fetchIssues() {
        throw new Error("jira boom");
      },
    };
    const fake = makeFakeScheduler();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const cfg = makeTempConfigYaml("watchedFolders: []\n");

    const handle = await runMonday({
      configPath: cfg,
      exitOnError: false,
      confluenceFetcher,
      jiraFetcher,
      scheduler: fake.scheduler,
    });

    // ready resolves even though both initial syncs rejected.
    await expect(handle.sources.ready).resolves.toBeUndefined();

    const fakeApp = handle.adapter._getApp() as unknown as { _started: boolean };
    expect(fakeApp._started).toBe(true);
    expect(handle.knowledge.getStatus().documentCount).toBe(0);

    await handle.shutdown();
    errSpy.mockRestore();
  });

  it("empty watchedFolders → watchFolder is never called (AC-5 parity)", async () => {
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_APP_TOKEN = APP_TOKEN;

    const watchSpy = jest.spyOn(knowledgeModule.KnowledgeService.prototype, "watchFolder");
    const fake = makeFakeScheduler();
    const cfg = makeTempConfigYaml("watchedFolders: []\n");

    const handle = await runMonday({
      configPath: cfg,
      exitOnError: false,
      scheduler: fake.scheduler,
    });

    expect(watchSpy).not.toHaveBeenCalled();

    await handle.shutdown();
    watchSpy.mockRestore();
  });
});
