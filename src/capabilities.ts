/**
 * #3306 — ONE shared capability source for every surface (Slack `/help`,
 * Telegram help cards). This module is the ONLY place that says what the bot
 * can do; each surface renders from it, so the shared parts can never drift.
 *
 * Contents:
 *   1. The command registry, moved VERBATIM from the module-private
 *      `AVAILABLE_COMMANDS` that used to live in `src/slack/commands.ts`
 *      (refactor only — `helpCommand()` delegates to `renderSlackHelp()` and
 *      its output stays byte-identical, golden-tested).
 *   2. ONE shared capability description — the plain-language "what this bot
 *      is and does" text every surface may embed.
 *
 * PURE: no I/O, no imports from knowledge/llm/transport layers.
 */

export interface CapabilityCommand {
  name: string;
  description: string;
}

/**
 * The Slack command registry, byte-for-byte the list `helpCommand()` rendered
 * before #3306. Order and wording are load-bearing (golden test).
 */
export const AVAILABLE_COMMANDS: ReadonlyArray<CapabilityCommand> = [
  { name: "/ask <question>", description: "Ask the bot a question against the indexed docs." },
  { name: "/status-monday", description: "Show document count and uptime." },
  { name: "/sync-confluence [space]", description: "Trigger a fresh sync of the Confluence space." },
  { name: "/reindex", description: "Re-index all Confluence pages and Jira issues." },
  { name: "/jql <question>", description: "Turn an English defect question into JQL and show the matching defects." },
  { name: "/help", description: "Show this help message." },
  { name: "/feedback-monday <message>", description: "Send feedback to the bot maintainers." },
];

/**
 * The plain-language "what this bot is and does" line. The ONE shared
 * capability description — wherever a surface describes the bot's plain
 * capability, it embeds these exact bytes (AC-7b). Contains no slash-command
 * token, so a surface that renders it teaches nothing that dead-ends.
 */
export const SHARED_CAPABILITY_DESCRIPTION =
  "I'm a team knowledge assistant: I answer questions using the team's indexed documents " +
  "(wiki pages and issue tracker items) and cite the sources I used.";

/**
 * Registry command words that take an argument — derived, never duplicated:
 * exactly the registry entries whose usage string carries a payload marker
 * (`<…>` or `[…]`). The Telegram pre-retrieval gate uses this set so a
 * registry command TYPED WITH ITS PAYLOAD keeps today's byte-identical doc
 * path (it carries a real question), while anything else command-shaped is
 * unknown on Telegram and gets the help card.
 */
export const ARGUMENT_TAKING_COMMAND_WORDS: ReadonlySet<string> = new Set(
  AVAILABLE_COMMANDS.filter((c) => /[<[]/.test(c.name)).map((c) => c.name.split(" ")[0].slice(1)),
);

/** Every registry command token (leading word, with slash) — for the
 * Telegram card's "teaches no command that does not work there" check. */
export const REGISTRY_COMMAND_TOKENS: ReadonlyArray<string> = AVAILABLE_COMMANDS.map(
  (c) => c.name.split(" ")[0],
);

/**
 * Render the Slack `/help` text from the shared registry. Byte-identical to
 * the pre-#3306 `helpCommand()` output (golden-tested in AC-7a).
 */
export function renderSlackHelp(): string {
  const lines = AVAILABLE_COMMANDS.map((c) => `• ${c.name} — ${c.description}`);
  return ["Available commands:", ...lines].join("\n");
}
