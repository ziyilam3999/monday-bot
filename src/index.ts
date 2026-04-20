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
    throw err;
  }
}

main();
