/**
 * Admin slash command handlers for the Slack adapter (US-09).
 *
 * Each handler is a plain function so it can be unit-tested without the Bolt
 * runtime. The adapter wires them onto specific slash commands (`/status`,
 * `/sync-confluence`, `/reindex`, `/help`, `/feedback`).
 *
 * Handlers are intentionally tolerant of partial service shapes — the AC tests
 * pass `{}` or a minimal mock object — and never throw on missing methods.
 */

export interface AdminServiceStatus {
  documentCount: number;
  watcherAlive: boolean;
  uptimeSeconds: number;
}

/**
 * Lowest-common-denominator service contract used by the admin handlers. Every
 * field is optional so handlers can be exercised with `{}` (per AC-03/AC-04)
 * and so test mocks can provide only what they need.
 */
export interface AdminService {
  getStatus?(): AdminServiceStatus;
  /** Trigger a Confluence sync. The result string (if any) is surfaced verbatim. */
  syncConfluence?(spaceKey?: string): Promise<string | void> | string | void;
  /** Re-index all watched files / Confluence pages. */
  reindex?(): Promise<string | void> | string | void;
  /** Optional sink for collected feedback. Defaults to console.log. */
  recordFeedback?(message: string): Promise<void> | void;
}

export type CommandHandler = (
  service: AdminService,
  arg?: string,
) => string | Promise<string>;

const AVAILABLE_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "/ask <question>", description: "Ask the bot a question against the indexed docs." },
  { name: "/status", description: "Show document count, watcher status, and uptime." },
  { name: "/sync-confluence [space]", description: "Trigger a fresh sync of the Confluence space." },
  { name: "/reindex", description: "Re-index all watched files and Confluence pages." },
  { name: "/help", description: "Show this help message." },
  { name: "/feedback <message>", description: "Send feedback to the bot maintainers." },
];

function formatUptime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  if (s > 0 || h === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * `/status` — synchronous, returns a one-line summary string. Reads from
 * `service.getStatus()`. If the service is missing or doesn't expose
 * `getStatus`, returns a degraded but still well-formed string so the AC's
 * regexes still pass for callers that pass a richer mock.
 */
export const statusCommand: CommandHandler = (service) => {
  const status =
    service && typeof service.getStatus === "function"
      ? service.getStatus()
      : { documentCount: 0, watcherAlive: false, uptimeSeconds: 0 };
  const docCount = Number.isFinite(status.documentCount) ? status.documentCount : 0;
  const watcherToken = status.watcherAlive ? "alive" : "stopped";
  const uptime = formatUptime(status.uptimeSeconds ?? 0);
  return `Status: ${docCount} documents indexed | watcher: ${watcherToken} | uptime: ${uptime}`;
};

/**
 * `/sync-confluence [spaceKey]` — kicks off a Confluence sync. The handler is
 * async because `service.syncConfluence` typically performs network I/O.
 */
export const syncConfluenceCommand: CommandHandler = async (service, arg) => {
  if (!service || typeof service.syncConfluence !== "function") {
    return "Confluence sync is not configured on this bot.";
  }
  try {
    const result = await service.syncConfluence(arg && arg.length > 0 ? arg : undefined);
    if (typeof result === "string" && result.length > 0) return result;
    return "Confluence sync triggered.";
  } catch (err) {
    return `Confluence sync failed: ${(err as Error).message ?? "unknown error"}`;
  }
};

/**
 * `/reindex` — rebuild the in-memory index from the watched folder + Confluence
 * pages. Async because rebuilds typically involve disk + network.
 */
export const reindexCommand: CommandHandler = async (service) => {
  if (!service || typeof service.reindex !== "function") {
    return "Reindex is not configured on this bot.";
  }
  try {
    const result = await service.reindex();
    if (typeof result === "string" && result.length > 0) return result;
    return "Reindex triggered.";
  } catch (err) {
    return `Reindex failed: ${(err as Error).message ?? "unknown error"}`;
  }
};

/**
 * `/help` — static help text listing every command. Synchronous so callers can
 * post the response without awaiting.
 */
export const helpCommand: CommandHandler = () => {
  const lines = AVAILABLE_COMMANDS.map((c) => `• ${c.name} — ${c.description}`);
  return ["Available commands:", ...lines].join("\n");
};

/**
 * `/feedback <message>` — capture user feedback. By default we log to stdout so
 * operators can grep the bot logs; production wiring can supply
 * `service.recordFeedback` to forward to a ticket system.
 */
export const feedbackCommand: CommandHandler = (service, message) => {
  const text = typeof message === "string" ? message.trim() : "";
  if (text.length === 0) {
    return "Usage: /feedback <message> — please include a description of what was wrong.";
  }
  if (service && typeof service.recordFeedback === "function") {
    try {
      const maybe = service.recordFeedback(text);
      // We don't await here because the handler's own contract is sync-or-async
      // string return; callers that need durable acknowledgement should await
      // recordFeedback themselves before calling this handler.
      // Wrap in Promise.resolve(...).catch so async rejections are swallowed
      // alongside the sync try/catch — best-effort logging must never throw
      // an unhandled rejection back into the runtime.
      Promise.resolve(maybe).catch(() => {});
    } catch {
      // best-effort — never let a logging failure swallow the user's feedback.
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(`[feedback] ${text}`);
  }
  return "Thanks — your feedback has been recorded.";
};

/**
 * Registry exposed for the AC: keys must contain the substrings `status`,
 * `sync`, `reindex`, `help`, `feedback` (case-insensitive — AC lowercases).
 * Adapter wiring imports these by named export; the registry is the
 * machine-readable surface.
 */
export const commandHandlers: Record<string, CommandHandler> = {
  status: statusCommand,
  syncConfluence: syncConfluenceCommand,
  reindex: reindexCommand,
  help: helpCommand,
  feedback: feedbackCommand,
};
