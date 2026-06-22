import { App } from "@slack/bolt";
import { MissingEnvVarError, validateEnv, AppEnv } from "./config/env";
import { loadConfig } from "./config/config";
import { KnowledgeService } from "./knowledge/service";
import { SlackAdapter, AppFactory } from "./slack/adapter";

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
}

export interface RunMondayHandle {
  adapter: SlackAdapter;
  knowledge: KnowledgeService;
  /** Idempotent shutdown — stops the Slack adapter and folder watchers. */
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
  try {
    const config = loadConfig(opts.configPath);
    watchedFolders = config.watchedFolders ?? [];
  } catch (err) {
    return handleStartupError(err);
  }

  const knowledge = new KnowledgeService();
  for (const folder of watchedFolders) {
    try {
      knowledge.watchFolder(folder);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Monday: failed to watch folder ${folder}: ${message} (continuing)`);
    }
  }

  const appFactoryExplicitlySupplied = opts.appFactory !== undefined;
  let appFactory = opts.appFactory;
  if (!appFactory && process.env.MONDAY_TEST_MODE === "1") {
    appFactory = createFakeAppFactory();
  }

  let adapter: SlackAdapter;
  try {
    adapter = new SlackAdapter({
      botToken: env.slackBotToken,
      appToken: env.slackAppToken,
      knowledgeService: knowledge,
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

  return { adapter, knowledge, shutdown };
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
