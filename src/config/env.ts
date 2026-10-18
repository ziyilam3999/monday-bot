const REQUIRED_ENV_VARS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] as const;

export interface AppEnv {
  slackBotToken: string;
  slackAppToken: string;
  /** #3277 — Telegram bot token. Undefined when the Telegram adapter stays off. */
  telegramBotToken?: string;
  /** #3277 — allowed Telegram chat ids (fail closed when token set but list empty). */
  telegramAllowedChatIds: number[];
}

export class MissingEnvVarError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        `Set these in your .env file or shell before starting Monday. ` +
        `See .env.example for the full list of expected variables.`
    );
    this.name = "MissingEnvVarError";
  }
}

/**
 * Parse the optional `JIRA_DEFAULT_PROJECTS` env value into a list of project
 * keys (#1363). Comma-separated, trimmed, empties dropped — mirrors the
 * `JIRA_PROJECTS` convention (see `splitList` in `src/knowledge/startup.ts`).
 *
 * Deliberately does NOT uppercase: the pure JQL builder already
 * uppercases/sanitises every project key for injection-safety
 * (`jqlFromFilter.ts` — `project in (...)` clause), so re-uppercasing here would
 * be redundant. Kept as a standalone, side-effect-free helper so the parse seam
 * is unit-testable in isolation.
 */
export function parseDefaultProjects(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse the optional `TELEGRAM_ALLOWED_CHAT_IDS` env value (#3277) into chat
 * ids. Comma-separated, trimmed, empties dropped — mirrors
 * `parseDefaultProjects`. The minus sign is KEPT: Telegram group-chat ids are
 * negative. Any non-numeric entry yields an EMPTY array so the adapter's
 * fail-closed gate fires (a half-parsed allow-list must never silently allow a
 * subset).
 *
 * Consequence stated here and in docs/telegram.md: an allow-list entry is a
 * WHOLE chat — allowing a group id lets EVERY member of that group query the
 * knowledge base. v1 guidance: allow only private, per-person chat ids.
 */
export function parseTelegramChatIds(value: string | undefined): number[] {
  if (!value) return [];
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return [];
  const ids: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n)) return [];
    ids.push(n);
  }
  return ids;
}

export function validateEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const missing = REQUIRED_ENV_VARS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new MissingEnvVarError(missing);
  }
  return {
    slackBotToken: env.SLACK_BOT_TOKEN!.trim(),
    slackAppToken: env.SLACK_APP_TOKEN!.trim(),
    // #3277 — optional second channel: undefined token ⇒ no Telegram object is
    // ever constructed. REQUIRED_ENV_VARS is deliberately NOT touched so
    // Slack-only deployments keep booting exactly as before.
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramAllowedChatIds: parseTelegramChatIds(env.TELEGRAM_ALLOWED_CHAT_IDS),
  };
}
