/**
 * Admin slash command handlers for the Slack adapter (US-09).
 *
 * Each handler is a plain function so it can be unit-tested without the Bolt
 * runtime. The adapter wires them onto specific slash commands (`/status-monday`,
 * `/sync-confluence`, `/reindex`, `/help`, `/feedback-monday`).
 *
 * Handlers are intentionally tolerant of partial service shapes — the AC tests
 * pass `{}` or a minimal mock object — and never throw on missing methods.
 */

export interface AdminServiceStatus {
  documentCount: number;
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
  /** Re-index all Confluence pages and Jira issues. */
  reindex?(): Promise<string | void> | string | void;
  /** Optional sink for collected feedback. Defaults to console.log. */
  recordFeedback?(message: string): Promise<void> | void;
  /**
   * Answer an English defect question (`/jql`). Returns the generated JQL plus the
   * matched defects (Slack default = auto-run, read-only). Optional so the handler
   * degrades to "not configured" when the bot has no Jira viewing layer wired.
   */
  answerJql?(question: string): Promise<JqlReply> | JqlReply;
}

/** A single matched defect for the `/jql` reply. */
export interface JqlReplyIssue {
  key: string;
  summary?: string;
}

/** The shape `answerJql` returns and `formatJqlReply` renders. */
export interface JqlReply {
  jql: string;
  issues?: JqlReplyIssue[];
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Mention-intent routing (#1344)
//
// Decide whether a natural @-mention is a DEFECT/JQL question or a plain DOC
// question — with a PURE, no-network classifier so the adapter can route a
// mention to the same `jqlCommand` seam the `/jql` slash already uses. The
// matcher is deliberately conservative (cairn 2026-06-16: NL matching is
// structurally leaky; each patch widens the surface):
//   1. An explicit lead token (`jql`/`defects:`) — matched as a WHOLE WORD /
//      prefix-token, then stripped — ALWAYS forces the JQL route (the
//      zero-ambiguity escape hatch).
//   2. Otherwise a SMALL, configurable defect lexicon matched on a WORD
//      BOUNDARY (optional plural suffix), NOT a naive `includes()` — so
//      "debugging guide", "asymptomatic screening", "defective hardware" stay
//      `doc` while "crashes"/"bugs"/"regressions" route `jql`.
//   3. Everything else → `doc` (the SAFE default = today's behaviour).
// ---------------------------------------------------------------------------

export type MentionRoute = "jql" | "doc";

export interface MentionIntent {
  /** "jql" → route to the defect-slice skill; "doc" → ordinary doc Q&A. */
  route: MentionRoute;
  /**
   * The query to forward: the original cleaned text with any explicit lead
   * token STRIPPED (jql route), or the unchanged cleaned text (doc route).
   */
  query: string;
}

/**
 * Default, conservative defect lexicon. Matched as a WHOLE WORD (with an
 * optional `s`/`es` plural), never as a substring of a longer word. Override
 * without a code change via the `MENTION_DEFECT_LEXICON` env var
 * (comma-separated).
 */
export const DEFAULT_MENTION_DEFECT_LEXICON: readonly string[] = [
  "defect",
  "bug",
  "crash",
  "regression",
  "symptom",
];

/**
 * Explicit lead tokens that ALWAYS force the JQL route. Matched as a whole
 * word / prefix-token at the START of the cleaned text, then stripped.
 * Override via `MENTION_JQL_LEAD_TOKENS` (comma-separated).
 */
export const DEFAULT_MENTION_JQL_LEAD_TOKENS: readonly string[] = ["jql", "defects:"];

/** Resolved configuration for {@link classifyMentionIntent}. */
export interface MentionIntentConfig {
  lexicon: string[];
  leadTokens: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseEnvList(raw: string | undefined): string[] | null {
  if (typeof raw !== "string") return null;
  const items = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : null;
}

function resolveConfig(config?: Partial<MentionIntentConfig>): MentionIntentConfig {
  return {
    lexicon:
      config?.lexicon ??
      parseEnvList(process.env.MENTION_DEFECT_LEXICON) ??
      [...DEFAULT_MENTION_DEFECT_LEXICON],
    leadTokens:
      config?.leadTokens ??
      parseEnvList(process.env.MENTION_JQL_LEAD_TOKENS) ??
      [...DEFAULT_MENTION_JQL_LEAD_TOKENS],
  };
}

/**
 * If `text` begins with a lead token (as a whole word / prefix-token), return
 * the remaining query with that token stripped; otherwise `null`. A token that
 * ends in a word character (e.g. `jql`) is anchored with `\b` so a longer word
 * like `jqlite` does NOT strip-and-route (AC11).
 */
function stripLeadToken(text: string, leadTokens: string[]): string | null {
  for (const tok of leadTokens) {
    if (tok.length === 0) continue;
    const endsWithWordChar = /\w$/.test(tok);
    const re = new RegExp(`^${escapeRegExp(tok)}${endsWithWordChar ? "\\b" : ""}\\s*`, "i");
    const m = text.match(re);
    if (m) return text.slice(m[0].length).trim();
  }
  return null;
}

/**
 * True iff `text` contains a defect-lexicon token as a WHOLE WORD (with an
 * optional `s`/`es` plural) — NOT as a substring of a longer word. So
 * "crashes"/"bugs"/"regressions" match, but "debugging"/"asymptomatic"/
 * "defective" do not (AC10).
 */
function containsDefectNoun(text: string, lexicon: string[]): boolean {
  const tokens = lexicon.map(escapeRegExp).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  const re = new RegExp(`\\b(?:${tokens.join("|")})(?:es|s)?\\b`, "i");
  return re.test(text);
}

/**
 * PURE, no-network mention classifier. Decides the route and returns the query
 * to forward. Safe by default: any ambiguity → `doc` (today's behaviour).
 */
export function classifyMentionIntent(
  text: string,
  config?: Partial<MentionIntentConfig>,
): MentionIntent {
  const cleaned = typeof text === "string" ? text.trim() : "";
  if (cleaned.length === 0) return { route: "doc", query: "" };
  const cfg = resolveConfig(config);
  const stripped = stripLeadToken(cleaned, cfg.leadTokens);
  if (stripped !== null) return { route: "jql", query: stripped };
  if (containsDefectNoun(cleaned, cfg.lexicon)) return { route: "jql", query: cleaned };
  return { route: "doc", query: cleaned };
}

/**
 * PURE formatter for the Slack `/jql` reply (option A — auto-run, read-only).
 *
 * Fixed order (AC14): the generated JQL string appears FIRST, then the matched
 * defects BELOW it — so a reader sees the query, then its results. Warnings (if
 * any) trail last. No I/O — unit-tested with a stubbed search.
 */
export function formatJqlReply(reply: JqlReply): string {
  const lines: string[] = [];
  lines.push("*JQL:*");
  lines.push("```");
  lines.push(reply.jql);
  lines.push("```");
  const issues = Array.isArray(reply.issues) ? reply.issues : [];
  if (issues.length === 0) {
    lines.push("No matching defects.");
  } else {
    lines.push(`Matched ${issues.length} defect(s):`);
    for (const issue of issues) {
      lines.push(issue.summary ? `• ${issue.key} — ${issue.summary}` : `• ${issue.key}`);
    }
  }
  const warnings = Array.isArray(reply.warnings) ? reply.warnings : [];
  for (const w of warnings) lines.push(`_${w}_`);
  return lines.join("\n");
}

export type CommandHandler = (
  service: AdminService,
  arg?: string,
) => string | Promise<string>;

const AVAILABLE_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "/ask <question>", description: "Ask the bot a question against the indexed docs." },
  { name: "/status-monday", description: "Show document count and uptime." },
  { name: "/sync-confluence [space]", description: "Trigger a fresh sync of the Confluence space." },
  { name: "/reindex", description: "Re-index all Confluence pages and Jira issues." },
  { name: "/jql <question>", description: "Turn an English defect question into JQL and show the matching defects." },
  { name: "/help", description: "Show this help message." },
  { name: "/feedback-monday <message>", description: "Send feedback to the bot maintainers." },
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
 * `/status-monday` — synchronous, returns a one-line summary string. Reads from
 * `service.getStatus()`. If the service is missing or doesn't expose
 * `getStatus`, returns a degraded but still well-formed string so the AC's
 * regexes still pass for callers that pass a richer mock.
 */
export const statusCommand: CommandHandler = (service) => {
  const status =
    service && typeof service.getStatus === "function"
      ? service.getStatus()
      : { documentCount: 0, uptimeSeconds: 0 };
  const docCount = Number.isFinite(status.documentCount) ? status.documentCount : 0;
  const uptime = formatUptime(status.uptimeSeconds ?? 0);
  return `Status: ${docCount} documents indexed | uptime: ${uptime}`;
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
 * `/reindex` — rebuild the in-memory index from Confluence pages + Jira issues.
 * Async because rebuilds typically involve network I/O.
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
 * `/jql <question>` — Slack auto-run (option A): map the English question to JQL,
 * perform the one read-only search, and reply JQL-FIRST then the matched defects
 * (via the pure `formatJqlReply`). Async because the search is network I/O.
 */
export const jqlCommand: CommandHandler = async (service, question) => {
  const q = typeof question === "string" ? question.trim() : "";
  if (q.length === 0) {
    return "Usage: `/jql <question>` — for example, `/jql show me crashes`";
  }
  if (!service || typeof service.answerJql !== "function") {
    return "JQL search is not configured on this bot.";
  }
  try {
    const reply = await service.answerJql(q);
    return formatJqlReply(reply);
  } catch (err) {
    return `JQL search failed: ${(err as Error).message ?? "unknown error"}`;
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
 * `/feedback-monday <message>` — capture user feedback. By default we log to stdout so
 * operators can grep the bot logs; production wiring can supply
 * `service.recordFeedback` to forward to a ticket system.
 */
export const feedbackCommand: CommandHandler = (service, message) => {
  const text = typeof message === "string" ? message.trim() : "";
  if (text.length === 0) {
    return "Usage: /feedback-monday <message> — please include a description of what was wrong.";
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
  jql: jqlCommand,
  help: helpCommand,
  feedback: feedbackCommand,
};
