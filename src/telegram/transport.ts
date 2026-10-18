/**
 * #3277 — Telegram Bot API transport (outbound-only long polling).
 *
 * The bot token rides in every request URL (`/bot<token>/<method>`), so the
 * redaction rule here is load-bearing: every failure — fetch rejection or
 * non-2xx response — is rethrown as a `TelegramTransportError` whose message
 * carries ONLY the method name, the HTTP status (when present) and the
 * underlying error's class name. NEVER the request URL, never a `/bot` path
 * segment, never `String(err)` of the raw cause (a fetch rejection message can
 * embed the full URL with the token in it). Unlike the Slack side's
 * `slackBotToken.slice(0, 5)` precedent, the Telegram path never logs a token
 * slice or fragment of any length.
 */

/** Minimal local update shape — only the fields the adapter reads. */
export interface TgUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
}

export class TelegramTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramTransportError";
  }
}

/** Injectable transport seam — tests supply a fake; prod uses the HTTP one. */
export interface TelegramTransport {
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<unknown>;
  /** Optional: abort an in-flight HTTP call (clean shutdown). */
  abortInFlight?(): void;
}

/** Structural slice of the native `fetch` signature this transport needs. */
export interface TelegramFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type TelegramFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<TelegramFetchResponse>;

function errorClassName(err: unknown): string {
  if (err instanceof Error) return err.constructor.name;
  return typeof err;
}

export class HttpTelegramTransport implements TelegramTransport {
  private readonly apiBase: string;
  private readonly fetchFn: TelegramFetch;
  private controller: AbortController | null = null;

  constructor(opts: { botToken: string; fetchFn?: TelegramFetch }) {
    const token = (opts?.botToken ?? "").trim();
    if (token.length === 0) {
      throw new TelegramTransportError("HttpTelegramTransport: botToken is required");
    }
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this.fetchFn =
      opts.fetchFn ?? ((globalThis as unknown as { fetch: TelegramFetch }).fetch);
  }

  async getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]> {
    const result = await this.call("getUpdates", { offset, timeout: timeoutSec });
    return Array.isArray(result) ? (result as TgUpdate[]) : [];
  }

  async sendMessage(chatId: number, text: string): Promise<unknown> {
    // Plain text only — deliberately NO parse_mode (v1: no MarkdownV2/HTML
    // escaping surface; Telegram renders the text as-is).
    return this.call("sendMessage", { chat_id: chatId, text });
  }

  abortInFlight(): void {
    this.controller?.abort();
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.controller = new AbortController();
    let response: TelegramFetchResponse;
    try {
      response = await this.fetchFn(`${this.apiBase}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: this.controller.signal,
      });
    } catch (err) {
      throw new TelegramTransportError(
        `${method} failed: network error (${errorClassName(err)})`,
      );
    }
    if (!response.ok) {
      throw new TelegramTransportError(`${method} failed: HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TelegramTransportError(`${method} failed: malformed response body`);
    }
    const parsed = body as { ok?: boolean; result?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || parsed.ok !== true) {
      // The API's own `description` is deliberately NOT echoed — redaction is
      // by shape, not by trust in upstream error text.
      throw new TelegramTransportError(`${method} failed: unexpected API response`);
    }
    return parsed.result;
  }
}
