import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "@slack/bolt";
import { MissingEnvVarError, validateEnv, AppEnv } from "./config/env";
import { loadConfig, AppConfig } from "./config/config";
import { KnowledgeService } from "./knowledge/service";
import {
  startKnowledgeSources,
  KnowledgeSourcesHandle,
  Scheduler,
} from "./knowledge/startup";
import { ConfluenceFetcher } from "./confluence/sync";
import { JiraFetcher } from "./jira/sync";
import { SlackAdapter, AppFactory } from "./slack/adapter";
import { AdminService } from "./slack/commands";

export interface RunMondayOptions {
  /** Override Bolt App factory (jest tests + AC-06 shell-spawn path). */
  appFactory?: AppFactory;
  /** Override config.yaml path. Defaults to <cwd>/config.yaml. */
  configPath?: string;
  /**
   * If true (production default), startup errors call `process.exit(1)`.
   * If false (jest tests), startup errors are thrown so callers can assert.
   */
  exitOnError?: boolean;
  /** Inject a Confluence fetcher (tests). Defaults to a real one built from env. */
  confluenceFetcher?: ConfluenceFetcher;
  /** Inject a Jira fetcher (tests). Defaults to a real one built from env. */
  jiraFetcher?: JiraFetcher;
  /** Inject a scheduler (tests) so no real timers leak. */
  scheduler?: Scheduler;
}

export interface RunMondayHandle {
  adapter: SlackAdapter;
  knowledge: KnowledgeService;
  /** Knowledge-source sync handle (Confluence + Jira). Exposed for tests. */
  sources: KnowledgeSourcesHandle;
  /** Idempotent shutdown — stops the Slack adapter, folder watchers, and sync timers. */
  shutdown: () => Promise<void>;
}

/**
 * Inline no-op fake Bolt App. Used only when MONDAY_TEST_MODE=1 is set and no
 * explicit `appFactory` was supplied — i.e. the AC-06 shell-spawn verifier
 * (`node dist/index.js` with stub Slack tokens). Production has MONDAY_TEST_MODE
 * unset and so always falls through to the real `@slack/bolt` App.
 */
function createFakeAppFactory(): AppFactory {
  return ((_opts: unknown) => {
    const handlers = new Map<string, unknown>();
    return {
      event: (name: string, handler: unknown) => handlers.set(`event:${name}`, handler),
      command: (name: string, handler: unknown) => handlers.set(`command:${name}`, handler),
      start: async () => undefined,
      stop: async () => undefined,
    } as unknown as App;
  }) as AppFactory;
}

/**
 * Durable feedback sink. Echoes to stdout (`[feedback] …`, unchanged) AND
 * best-effort appends a timestamped line to a log file. Resolves the path from
 * `MONDAY_FEEDBACK_LOG` (override) else `~/Library/Logs/monday-bot-feedback.log`.
 * ALL file I/O is wrapped in try/catch that SWALLOWS errors — a read-only FS or
 * a missing dir (ubuntu/windows CI) must never throw.
 */
export function recordFeedbackToSink(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[feedback] ${message}`);
  try {
    const logPath =
      process.env.MONDAY_FEEDBACK_LOG ??
      path.join(os.homedir(), "Library", "Logs", "monday-bot-feedback.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* best-effort — never throw (read-only FS / CI must not break) */
  }
}

export async function runMonday(opts: RunMondayOptions = {}): Promise<RunMondayHandle> {
  const exitOnError = opts.exitOnError ?? true;

  const handleStartupError = (err: unknown): never => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nMonday cannot start: ${message}\n`);
    if (
      process.env.MONDAY_DEBUG === "1" &&
      err instanceof Error &&
      err.stack &&
      !(err instanceof MissingEnvVarError)
    ) {
      console.error(err.stack);
    }
    if (exitOnError) {
      process.exit(1);
    }
    throw err instanceof Error ? err : new Error(message);
  };

  let env: AppEnv;
  try {
    env = validateEnv();
  } catch (err) {
    return handleStartupError(err);
  }

  let watchedFolders: string[];
  let config: AppConfig;
  try {
    config = loadConfig(opts.configPath);
    watchedFolders = config.watchedFolders ?? [];
  } catch (err) {
    return handleStartupError(err);
  }

  // Thread the recall v2 ranking levers (#1191) from config.yaml into the
  // long-lived KnowledgeService — this is THE instance the Slack adapter answers
  // from (passed to SlackAdapter below → handleQuery), so the levers run on the
  // real Slack path, not just in tests. config.recall omitted → shipped defaults
  // (expansion ON, diversity cap ON, rerank OFF).
  const knowledge = new KnowledgeService({ recall: config.recall });
  for (const folder of watchedFolders) {
    try {
      knowledge.watchFolder(folder);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Monday: failed to watch folder ${folder}: ${message} (continuing)`);
    }
  }

  // Wire Confluence + Jira knowledge sources (env-driven; skips cleanly when
  // creds absent). Initial sync runs in the background — it MUST NOT block
  // adapter.start() and a sync failure MUST NOT crash startup.
  const sources = startKnowledgeSources({
    knowledge,
    env: process.env,
    config,
    confluenceFetcher: opts.confluenceFetcher,
    jiraFetcher: opts.jiraFetcher,
    scheduler: opts.scheduler,
  });

  const appFactoryExplicitlySupplied = opts.appFactory !== undefined;
  let appFactory = opts.appFactory;
  if (!appFactory && process.env.MONDAY_TEST_MODE === "1") {
    appFactory = createFakeAppFactory();
  }

  // Admin surface for the Slack slash commands. /status-monday keeps its real
  // doc count via knowledge.getStatus(); /sync-confluence + /reindex forward to
  // the on-demand re-sync methods on the knowledge-sources handle.
  const adminService: AdminService = {
    getStatus: () => knowledge.getStatus(),
    syncConfluence: (spaceKey?: string) => sources.syncConfluence(spaceKey),
    reindex: () => sources.reindexAll(),
    recordFeedback: (message: string) => recordFeedbackToSink(message),
  };

  let adapter: SlackAdapter;
  try {
    adapter = new SlackAdapter({
      botToken: env.slackBotToken,
      appToken: env.slackAppToken,
      knowledgeService: knowledge,
      adminService,
      appFactory,
    });
  } catch (err) {
    return handleStartupError(err);
  }

  try {
    await adapter.start();
  } catch (err) {
    return handleStartupError(err);
  }

  console.log(
    `Monday is listening (Socket Mode). Slack bot token configured (${env.slackBotToken.slice(0, 5)}...).`,
  );

  // Signal listener references — captured so shutdown() can remove them,
  // preventing listener accumulation when runMonday() is called repeatedly.
  let onSIGINT: (() => void) | undefined;
  let onSIGTERM: (() => void) | undefined;

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (onSIGINT) process.off("SIGINT", onSIGINT);
    if (onSIGTERM) process.off("SIGTERM", onSIGTERM);
    try {
      await adapter.stop();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Monday: error stopping Slack adapter: ${message}`);
    }
    sources.stop();
    knowledge.stopWatching();
  };

  if (exitOnError) {
    const onSignal = (signal: string): void => {
      console.log(`Monday: received ${signal}, shutting down…`);
      shutdown()
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Monday: shutdown error: ${message}`);
        })
        .finally(() => {
          process.exit(0);
        });
    };
    onSIGINT = (): void => onSignal("SIGINT");
    onSIGTERM = (): void => onSignal("SIGTERM");
    process.once("SIGINT", onSIGINT);
    process.once("SIGTERM", onSIGTERM);

    // In test mode (no real Slack workspace), exit cleanly after the ready-log
    // so AC-06's shell verifier can rely on `set -o pipefail` + `timeout` without
    // the timeout-signal exit-code (124) masking the success path.
    // Guard: only fire when no explicit appFactory was injected — callers that
    // supply a real factory intend to keep the process alive for test assertions.
    if (process.env.MONDAY_TEST_MODE === "1" && !appFactoryExplicitlySupplied) {
      setImmediate(() => {
        shutdown().finally(() => process.exit(0));
      });
    }
  }

  return { adapter, knowledge, sources, shutdown };
}

if (require.main === module) {
  // Load .env for the CLI entry path only. Native (Node >=20.12), dependency-free.
  // A missing .env is fine — fall back to shell-exported env vars.
  try {
    process.loadEnvFile();
  } catch {
    /* no .env file — rely on shell-exported env vars */
  }
  runMonday().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Monday: unhandled error during startup: ${message}`);
    process.exit(1);
  });
}
