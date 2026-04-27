import { App, LogLevel } from "@slack/bolt";
import { formatAnswer } from "./formatter";
import {
  AdminService,
  statusCommand,
  syncConfluenceCommand,
  reindexCommand,
  helpCommand,
  feedbackCommand,
} from "./commands";

/**
 * Minimal contract the adapter requires from the knowledge layer. We don't import
 * `KnowledgeService` directly so the adapter stays decoupled from the concrete
 * class — any object with this shape works (including test fakes).
 */
export interface AnswerProvider {
  query(question: string): Promise<{
    answer: string;
    citations: Array<{ num?: number; number?: number; source: string; heading?: string }>;
  }>;
}

export interface SlackAdapterOptions {
  /** xoxb- bot token. Required. */
  botToken: string;
  /** xapp- app-level token used by Socket Mode. Required. */
  appToken: string;
  /** Knowledge service used to answer questions. Required. */
  knowledgeService: AnswerProvider | null | undefined;
  /**
   * Optional admin surface used by /status, /sync-confluence, /reindex,
   * /feedback. May be the same object as `knowledgeService` if it implements
   * both contracts. Missing methods degrade to "not configured" responses.
   */
  adminService?: AdminService;
  /**
   * Optional override for the Bolt `App` constructor. Used by tests to inject a
   * fake without monkey-patching the SDK at runtime.
   */
  appFactory?: AppFactory;
  /** Optional log level. Defaults to LogLevel.INFO. */
  logLevel?: LogLevel;
}

export type AppFactory = (opts: ConstructorParameters<typeof App>[0]) => App;

export class SlackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackConfigError";
  }
}

const DEFAULT_FALLBACK_TEXT =
  "Sorry, I hit an error while looking that up. Please try again or check the bot logs.";

/**
 * Slack adapter — connects via Socket Mode and routes `app_mention` events plus
 * the `/ask` slash command to the injected knowledge service. Replies are
 * formatted via `formatAnswer` and posted in-thread for mentions, ephemerally
 * for slash commands.
 */
export class SlackAdapter {
  private readonly botToken: string;
  private readonly appToken: string;
  private readonly knowledgeService: AnswerProvider;
  private readonly adminService: AdminService;
  private readonly app: App;

  constructor(opts: SlackAdapterOptions) {
    if (!opts || typeof opts !== "object") {
      throw new SlackConfigError("SlackAdapter: options object is required");
    }
    if (typeof opts.botToken !== "string" || opts.botToken.trim().length === 0) {
      throw new SlackConfigError(
        "SlackAdapter: botToken is required (set SLACK_BOT_TOKEN; missing or empty token rejected)",
      );
    }
    if (typeof opts.appToken !== "string" || opts.appToken.trim().length === 0) {
      throw new SlackConfigError(
        "SlackAdapter: appToken is required (set SLACK_APP_TOKEN; missing or empty token rejected)",
      );
    }
    if (!opts.knowledgeService || typeof (opts.knowledgeService as AnswerProvider).query !== "function") {
      throw new SlackConfigError(
        "SlackAdapter: knowledgeService is required and must expose a query(question) method",
      );
    }

    this.botToken = opts.botToken.trim();
    this.appToken = opts.appToken.trim();
    this.knowledgeService = opts.knowledgeService;
    // Default: if the knowledgeService object also exposes admin methods (e.g.
    // KnowledgeService's getStatus()), use it for /status. Otherwise the admin
    // surface is empty and individual handlers degrade to "not configured".
    this.adminService = opts.adminService ?? (opts.knowledgeService as unknown as AdminService) ?? {};

    const factory: AppFactory = opts.appFactory ?? ((appOpts) => new App(appOpts));
    this.app = factory({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      logLevel: opts.logLevel ?? LogLevel.INFO,
    });

    this.registerHandlers();
  }

  private registerHandlers(): void {
    // app_mention: someone wrote "@monday <question>" in a channel. Reply in-thread.
    this.app.event("app_mention", async (args: any) => {
      const event = args?.event ?? {};
      const client = args?.client;
      const logger = args?.logger ?? console;
      const text: string = typeof event.text === "string" ? event.text : "";
      const channel: string = typeof event.channel === "string" ? event.channel : "";
      // Strip ALL <@U123456> mentions (leading and interior) so the question is clean.
      const question = text.replace(/<@[^>]+>/g, "").replace(/\s+/g, " ").trim();
      const threadTs: string | undefined = event.thread_ts ?? event.ts;

      if (!question) {
        try {
          await client?.chat?.postMessage?.({
            channel,
            thread_ts: threadTs,
            text: "Hi — ask me a question and I'll search the indexed docs for an answer.",
          });
        } catch (err) {
          logger.error?.("SlackAdapter app_mention empty-question reply failed:", err);
        }
        return;
      }

      try {
        const result = await this.knowledgeService.query(question);
        const payload = formatAnswer(result);
        await client?.chat?.postMessage?.({
          channel,
          thread_ts: threadTs,
          text: payload.text,
          blocks: payload.blocks,
        });
      } catch (err) {
        logger.error?.("SlackAdapter app_mention handler failed:", err);
        try {
          await client?.chat?.postMessage?.({
            channel,
            thread_ts: threadTs,
            text: DEFAULT_FALLBACK_TEXT,
          });
        } catch {
          // best-effort fallback
        }
      }
    });

    // /ask <question> slash command. Acknowledge immediately, then reply ephemerally.
    this.app.command("/ask", async (args: any) => {
      const ack = args?.ack;
      const respond = args?.respond;
      const command = args?.command ?? {};
      const logger = args?.logger ?? console;
      try {
        await ack?.();
      } catch (err) {
        logger.error?.("SlackAdapter /ask ack failed:", err);
      }
      const question = typeof command.text === "string" ? command.text.trim() : "";
      if (!question) {
        await respond?.({
          response_type: "ephemeral",
          text: "Usage: `/ask <question>` — for example, `/ask how many days of annual leave do I get?`",
        });
        return;
      }
      try {
        const result = await this.knowledgeService.query(question);
        const payload = formatAnswer(result);
        await respond?.({
          response_type: "ephemeral",
          text: payload.text,
          blocks: payload.blocks,
        });
      } catch (err) {
        logger.error?.("SlackAdapter /ask handler failed:", err);
        await respond?.({
          response_type: "ephemeral",
          text: DEFAULT_FALLBACK_TEXT,
        });
      }
    });

    this.registerAdminCommand("/status", (_args, _text) => statusCommand(this.adminService));
    this.registerAdminCommand("/sync-confluence", (_args, text) =>
      syncConfluenceCommand(this.adminService, text),
    );
    this.registerAdminCommand("/reindex", (_args, _text) => reindexCommand(this.adminService));
    this.registerAdminCommand("/help", (_args, _text) => helpCommand(this.adminService));
    this.registerAdminCommand("/feedback", (_args, text) =>
      feedbackCommand(this.adminService, text),
    );
  }

  /**
   * Generic glue for admin commands: ack immediately, run the handler, post the
   * result ephemerally. Errors are logged and surfaced as a fallback message
   * rather than crashing the Bolt event loop.
   */
  private registerAdminCommand(
    name: string,
    runner: (args: unknown, text: string) => string | Promise<string>,
  ): void {
    this.app.command(name, async (args: any) => {
      const ack = args?.ack;
      const respond = args?.respond;
      const command = args?.command ?? {};
      const logger = args?.logger ?? console;
      try {
        await ack?.();
      } catch (err) {
        logger.error?.(`SlackAdapter ${name} ack failed:`, err);
      }
      const text = typeof command.text === "string" ? command.text.trim() : "";
      try {
        const reply = await runner(args, text);
        await respond?.({
          response_type: "ephemeral",
          text: reply,
        });
      } catch (err) {
        logger.error?.(`SlackAdapter ${name} handler failed:`, err);
        await respond?.({
          response_type: "ephemeral",
          text: DEFAULT_FALLBACK_TEXT,
        });
      }
    });
  }

  /** Connect to Slack via Socket Mode. */
  async start(): Promise<void> {
    await this.app.start();
  }

  /** Disconnect cleanly. Useful in tests and on shutdown. */
  async stop(): Promise<void> {
    await this.app.stop();
  }

  /** Exposed for tests — DO NOT use in production code. */
  _getApp(): App {
    return this.app;
  }
}
