/**
 * #3277 — Telegram adapter beside the Slack one. Mirrors `SlackAdapter` at the
 * seams the research verified channel-neutral: an injected AnswerProvider, every
 * question routed through the existing `handleQuery` (never throws), plain-text
 * replies split at 4096 chars, sequential sends.
 *
 * Safety / resilience contract:
 *   - Allow-list fails CLOSED: an empty `allowedChatIds` refuses construction
 *     (the error names TELEGRAM_ALLOWED_CHAT_IDS). A chat id not on the list
 *     gets silence — no query, no reply, no ask-log line.
 *   - Boot drain: the FIRST poll is `getUpdates(-1, 0)`; a returned batch is
 *     acknowledged and DISCARDED (offset = last id + 1) — anything sent while
 *     the bot was down is never answered, including the most recent queued
 *     message. An empty drain means the queue was verifiably empty (offset 0).
 *     A drain FAILURE rejects `start()` → the caller's startup-error channel
 *     (a bad token or a competing poller at boot is a misconfiguration).
 *   - Mid-run poll failures are NEVER process-fatal: bounded exponential
 *     backoff (5s doubling to a 60s cap), then self-park after 10 consecutive
 *     failed polls (one park line). A parked channel probes again on its own
 *     every PARKED_PROBE_MS and, after the first good probe, prints one back
 *     line and resumes the normal schedule — no restart is needed. Slack
 *     keeps running.
 */
import { handleQuery, QueryHandlerResult } from "../slack/queryHandler";
import {
  HttpTelegramTransport,
  TelegramTransport,
  TelegramTransportError,
  TgUpdate,
} from "./transport";
import { renderTelegramReply, splitMessage } from "./formatter";
import { recordAsk } from "./askLog";
import { classifyHelpGate } from "./helpGate";
import { buildHelpCard } from "./helpCard";

/**
 * Minimal contract the adapter requires from the knowledge layer — same shape
 * as the Slack adapter's `AnswerProvider`, kept local so the Telegram path
 * pulls in no Slack SDK code (test fakes included).
 */
export interface AnswerProvider {
  query(question: string): Promise<{
    answer: string;
    citations: Array<{ num?: number; number?: number; source: string; heading?: string }>;
  }>;
}

export type TransportFactory = () => TelegramTransport;
export type SleepFn = (ms: number) => Promise<void>;

export interface TelegramAdapterOptions {
  /** Bot token from TELEGRAM_BOT_TOKEN. Required. */
  botToken: string;
  /** Allowed chat ids from TELEGRAM_ALLOWED_CHAT_IDS. REQUIRED NON-EMPTY (fail closed). */
  allowedChatIds: number[];
  /** Knowledge service used to answer questions. Required. */
  knowledgeService: AnswerProvider | null | undefined;
  /** Optional transport override (tests). Defaults to the HTTP transport. */
  transportFactory?: TransportFactory;
  /** Optional ask-log path override (tests). Defaults to the askLog module's own resolution. */
  askLogPath?: string;
  /** Injectable sleep so tests observe backoff delays without wall-clock waiting. */
  sleepFn?: SleepFn;
  /** Minimum spacing between polls when a poll returns an EMPTY batch quickly
   * (fix round 1, finding 3): an instantly-resolving transport must not be
   * able to spin the loop. Default 1000ms; 0 disables (backoff-schedule tests). */
  minPollIntervalMs?: number;
  /** Injectable clock in epoch ms (fix round 1, finding 1): pins latencyMs
   * and the ask-log ts so ask-log assertions are deterministic. */
  nowFn?: () => number;
}

export class TelegramConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramConfigError";
  }
}

const DEFAULT_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 60000;
const MAX_CONSECUTIVE_FAILURES = 10;
/** Spacing of the single probe poll a PARKED channel makes (5 minutes). */
const PARKED_PROBE_MS = 300000;
const POLL_TIMEOUT_SEC = 25;
const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Normalized failure text for logging: a `TelegramTransportError`'s message is
 * already redacted (method + status + error class name only); anything else is
 * reduced to its class name — a raw message can embed the request URL with the
 * token in it, so it is never echoed.
 */
function safeErrorText(err: unknown): string {
  if (err instanceof TelegramTransportError) return err.message;
  if (err instanceof Error) return err.name;
  return "unknown error";
}

export class TelegramAdapter {
  private readonly botToken: string;
  private readonly allowedChatIds: number[];
  private readonly knowledgeService: AnswerProvider;
  private readonly transport: TelegramTransport;
  private readonly askLogPath: string | undefined;
  private readonly sleepFn: SleepFn;
  private readonly minPollIntervalMs: number;
  private readonly nowFn: () => number;
  private stopped = false;
  private loopDone: Promise<void> = Promise.resolve();
  private backoffWaiters: Array<() => void> = [];
  /** Timers created by the DEFAULT sleepFn — cleared in stop() so a clean
   * stop leaves no dangling 5-60s handle keeping the process alive. */
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(opts: TelegramAdapterOptions) {
    if (!opts || typeof opts !== "object") {
      throw new TelegramConfigError("TelegramAdapter: options object is required");
    }
    if (typeof opts.botToken !== "string" || opts.botToken.trim().length === 0) {
      throw new TelegramConfigError(
        "TelegramAdapter: botToken is required (set TELEGRAM_BOT_TOKEN; missing or empty token rejected)",
      );
    }
    if (
      !opts.knowledgeService ||
      typeof (opts.knowledgeService as AnswerProvider).query !== "function"
    ) {
      throw new TelegramConfigError(
        "TelegramAdapter: knowledgeService is required and must expose a query(question) method",
      );
    }
    if (!Array.isArray(opts.allowedChatIds) || opts.allowedChatIds.length === 0) {
      // Fail closed: a token with no allow-list must never serve silently.
      throw new TelegramConfigError(
        "TelegramAdapter: TELEGRAM_ALLOWED_CHAT_IDS must be a non-empty list of allowed chat ids " +
          "(empty or missing allow-list refuses to start — fail closed)",
      );
    }

    this.botToken = opts.botToken.trim();
    this.allowedChatIds = [...opts.allowedChatIds];
    this.knowledgeService = opts.knowledgeService;
    this.askLogPath = opts.askLogPath;
    this.sleepFn =
      opts.sleepFn ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.pendingTimers.delete(timer);
            resolve();
          }, ms);
          this.pendingTimers.add(timer);
        }));
    this.minPollIntervalMs = opts.minPollIntervalMs ?? 1000;
    this.nowFn = opts.nowFn ?? Date.now;
    this.transport = opts.transportFactory
      ? opts.transportFactory()
      : new HttpTelegramTransport({ botToken: this.botToken });
  }

  /**
   * Handle ONE update. Never throws — a `sendMessage` failure mid-batch
   * (#3277 execution-review MINOR 2) is caught here, logged with the
   * normalized error text, and does NOT charge the poll-failure streak: the
   * caller still advances the offset past this batch, so a network blip never
   * re-sends earlier parts as duplicates. Consequence, accepted: the remainder
   * of a multi-part reply after the failed part is dropped (truncated reply,
   * no duplicate partials).
   */
  async processUpdate(update: TgUpdate): Promise<void> {
    const message = update?.message;
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    if (!message || text.length === 0) return; // text-less update → ignore

    const chatId = message.chat?.id;
    if (typeof chatId !== "number" || !this.allowedChatIds.includes(chatId)) {
      return; // silence: no query, no reply, no ask-log line
    }

    // #3306 — pre-retrieval help-card gate: a command-shaped unknown slash
    // token, a short greeting, or a whole-message help probe gets ONE fixed
    // capability card — ZERO retrieval, ZERO LLM, and NO ask-log line (a card
    // is not an ask; the log must keep meaning "real asks" for the kill
    // rule). Anything else keeps today's byte-identical doc path below.
    const gate = classifyHelpGate(text);
    if (gate.card && gate.arm) {
      try {
        await this.transport.sendMessage(chatId, buildHelpCard(gate.arm));
      } catch (err) {
        console.error(`Telegram adapter: sendMessage failed (${safeErrorText(err)}).`);
      }
      return;
    }

    const startedAt = this.nowFn();
    // handleQuery never throws — a service error becomes the friendly fallback.
    const result: QueryHandlerResult = await handleQuery(text, this.knowledgeService);
    const latencyMs = this.nowFn() - startedAt;

    const rendered = renderTelegramReply(result);
    try {
      for (const part of splitMessage(rendered, TELEGRAM_MESSAGE_LIMIT)) {
        await this.transport.sendMessage(chatId, part);
      }
    } catch (err) {
      console.error(`Telegram adapter: sendMessage failed (${safeErrorText(err)}).`);
    }

    recordAsk(
      {
        chatId,
        questionLen: text.length,
        cited: (result.blocks ?? []).some((block) => block.type === "context"),
        latencyMs,
      },
      this.askLogPath,
      () => new Date(this.nowFn()),
    );
  }

  /**
   * Boot drain, then the steady poll loop in the background. A failure of the
   * FIRST drain call rejects `start()` (fail-closed at boot); every later
   * failure is handled inside the loop and never rejects.
   */
  async start(): Promise<void> {
    if (this.stopped) return;
    let boot: TgUpdate[];
    try {
      boot = await this.transport.getUpdates(-1, 0);
    } catch (err) {
      throw err instanceof TelegramTransportError
        ? err
        : new TelegramTransportError(safeErrorText(err));
    }
    // Drain rule: anything queued while the bot was down (including this most
    // recent update) is acknowledged and DISCARDED, never answered.
    const offset = boot.length > 0 ? boot[boot.length - 1].update_id + 1 : 0;
    this.loopDone = this.pollLoop(offset);
  }

  /**
   * Park-boundary arithmetic (#3277 execution-review MINOR 1 — check-then-park):
   * after the Nth consecutive failure the streak count is checked BEFORE any
   * sleep; at the 10th failure the adapter parks immediately with NO 10th
   * backoff sleep. A full 10-failure streak therefore spans exactly 9 sleeps —
   * 5+10+20+40+60+60+60+60+60 = 375s. A parked channel is not dead: it makes
   * ONE probe poll per PARKED_PROBE_MS sleep (same offset, same 25s timeout),
   * so no 10-minute window that starts at or after the park holds more than
   * 3 calls. The first good probe prints the back line and the loop returns
   * to the normal backoff schedule; stop() ends the parked wait.
   */
  private async pollLoop(offset: number): Promise<void> {
    let streak = 0;
    while (!this.stopped) {
      const pollStartedAt = this.nowFn();
      let batch: TgUpdate[];
      try {
        batch = await this.transport.getUpdates(offset, POLL_TIMEOUT_SEC);
      } catch (err) {
        if (this.stopped) return; // stop() aborted the in-flight poll
        streak += 1;
        if (streak >= MAX_CONSECUTIVE_FAILURES) {
          // Park: one line, then the probe wait. The line names the probe
          // cadence and the self-recovery — a restart is not part of it.
          console.error(
            `Telegram adapter: parking after ${streak} consecutive failed polls ` +
              `(${safeErrorText(err)}). The channel probes again every 5 minutes ` +
              `and comes back on its own; Slack keeps running.`,
          );
          const probe = await this.parkedProbe(offset);
          if (probe === null) return; // stop() ended the parked wait
          streak += probe.failedProbes;
          // The back line counts every failed poll since the last good one,
          // failed probes included. It carries no error text.
          console.error(`Telegram adapter: channel is back after ${streak} failed polls`);
          streak = 0; // back on the normal schedule: next failure backs off 5s
          offset = await this.consumeBatch(probe.batch, probe.startedAt, offset);
          continue;
        }
        // A sleep precedes EVERY retry — no zero-delay re-poll path exists.
        const delay = Math.min(DEFAULT_BACKOFF_MS * 2 ** (streak - 1), MAX_BACKOFF_MS);
        await this.sleepOrStop(delay);
        continue;
      }
      streak = 0; // one successful poll resets the schedule to the 5s floor
      offset = await this.consumeBatch(batch, pollStartedAt, offset);
    }
  }

  /**
   * The parked wait: ONE probe poll per PARKED_PROBE_MS through the injectable
   * sleep — a sleep comes before each probe, so no zero-delay re-poll path
   * exists. A failed probe prints nothing and keeps the channel parked; the
   * caller's streak still counts it. The first good probe ends the wait and
   * returns its batch; stop() ends the wait with null.
   */
  private async parkedProbe(
    offset: number,
  ): Promise<{ batch: TgUpdate[]; startedAt: number; failedProbes: number } | null> {
    let failedProbes = 0;
    while (!this.stopped) {
      await this.sleepOrStop(PARKED_PROBE_MS);
      if (this.stopped) return null;
      const startedAt = this.nowFn();
      try {
        const batch = await this.transport.getUpdates(offset, POLL_TIMEOUT_SEC);
        if (this.stopped) return null;
        return { batch, startedAt, failedProbes };
      } catch {
        if (this.stopped) return null;
        failedProbes += 1; // failed probe: stay parked, print nothing
      }
    }
    return null;
  }

  /**
   * Handle one successful batch (normal poll or good probe): answer its
   * updates, advance the offset past it, and hold the minimum pace after an
   * instant empty batch. Returns the offset the next poll must use.
   */
  private async consumeBatch(
    batch: TgUpdate[],
    pollStartedAt: number,
    offset: number,
  ): Promise<number> {
    for (const updateItem of batch) {
      if (this.stopped) return offset;
      await this.processUpdate(updateItem); // never throws; sends caught inside
    }
    if (batch.length > 0) {
      // Offset advances past the batch even if a sendMessage inside it
      // failed (see processUpdate) — no duplicate partial re-sends.
      return batch[batch.length - 1].update_id + 1;
    }
    if (this.minPollIntervalMs > 0) {
      // Minimum pace (fix round 1, finding 3): an instantly-returning
      // empty transport must not spin the loop microtask-only — the next
      // poll is held to at least minPollIntervalMs after this poll STARTED.
      // A non-empty batch takes the branch above with no added delay.
      const floor = this.minPollIntervalMs - (this.nowFn() - pollStartedAt);
      if (floor > 0) await this.sleepOrStop(floor);
    }
    return offset;
  }

  /** Sleep that a `stop()` can cut short (resolves immediately when stopped). */
  private sleepOrStop(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this.backoffWaiters = this.backoffWaiters.filter((w) => w !== done);
        resolve();
      };
      this.backoffWaiters.push(done);
      void Promise.resolve(this.sleepFn(ms)).then(done, done);
    });
  }

  /** Flip the stopped flag, clear any pending backoff sleep (waiters AND the
   * default sleepFn's own timer handles), abort the in-flight fetch. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const wake of this.backoffWaiters.splice(0)) wake();
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    this.transport.abortInFlight?.();
  }

  /** Test-only: resolves once the background poll loop has settled. A parked
   * loop stays alive (probing) — only stop() settles it. */
  _loopDone(): Promise<void> {
    return this.loopDone;
  }
}
