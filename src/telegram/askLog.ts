/**
 * #3277 — best-effort local ask log for the 2-week Telegram test. ONE JSON
 * line per ALLOWED ask: chat id hash (first 12 hex of sha256), question
 * LENGTH, cited yes/no, latency. The unsalted hash distinguishes askers for
 * the kill-rule tally — it is NOT a secrecy measure. Question TEXT and the raw
 * chat id are never stored.
 *
 * Mirrors `recordFeedbackToSink` (src/index.ts): path resolved from an env
 * override (`MONDAY_TELEGRAM_ASK_LOG`) else the runtime-homedir
 * `Library/Logs/monday-bot-telegram-asks.jsonl`; ALL file I/O is swallowed —
 * a read-only FS must never crash replies.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AskLogInput {
  chatId: number;
  questionLen: number;
  cited: boolean;
  latencyMs: number;
}

/** First 12 hex chars of sha256(String(chatId)) — distinct-asker tally, not secrecy. */
export function chatIdHash(chatId: number): string {
  return crypto.createHash("sha256").update(String(chatId)).digest("hex").slice(0, 12);
}

function defaultLogPath(): string {
  return path.join(os.homedir(), "Library", "Logs", "monday-bot-telegram-asks.jsonl");
}

/**
 * `nowFn` (fix round 1, finding 1) makes the ts injectable so the ask-log
 * privacy assertions are deterministic — they must never key on real-clock
 * timestamp digits (any digit pair occurs in some timestamp).
 */
export function recordAsk(
  input: AskLogInput,
  logPathOverride?: string,
  nowFn: () => Date = () => new Date(),
): void {
  try {
    const line = JSON.stringify({
      ts: nowFn().toISOString(),
      chatHash: chatIdHash(input.chatId),
      questionLen: input.questionLen,
      cited: input.cited,
      latencyMs: input.latencyMs,
    });
    const logPath = logPathOverride ?? process.env.MONDAY_TELEGRAM_ASK_LOG ?? defaultLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${line}\n`);
  } catch {
    /* best-effort — never throw (read-only FS / CI must not break replies) */
  }
}
