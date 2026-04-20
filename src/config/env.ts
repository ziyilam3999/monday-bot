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
