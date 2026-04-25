import { MissingEnvVarError, validateEnv } from "./config/env";

function main(): void {
  try {
    const env = validateEnv();
    console.log(
      `Monday is starting. Slack bot token configured (${env.slackBotToken.slice(0, 5)}...).`
    );
  } catch (err) {
    if (err instanceof MissingEnvVarError) {
      console.error(`\nMonday cannot start: ${err.message}\n`);
      process.exit(1);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nMonday cannot start: ${message}\n`);
    if (process.env.MONDAY_DEBUG === "1" && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
