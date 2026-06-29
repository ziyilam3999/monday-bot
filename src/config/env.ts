const REQUIRED_ENV_VARS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] as const;

export interface AppEnv {
  slackBotToken: string;
  slackAppToken: string;
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

export function validateEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const missing = REQUIRED_ENV_VARS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new MissingEnvVarError(missing);
  }
  return {
    slackBotToken: env.SLACK_BOT_TOKEN!.trim(),
    slackAppToken: env.SLACK_APP_TOKEN!.trim(),
  };
}
