/**
 * #3306 — PURE builder for the Telegram capability card. Plain text only: no
 * `Sources:` line, no citations, no parse_mode. The card renders the ONE
 * shared capability description plus the ask-in-plain-text line with
 * examples, and contains NO slash-command token — no slash command works on
 * Telegram, so the card can never teach a command that dead-ends or loops
 * there (AC-7c). Zero LLM, zero retrieval: imports nothing but the shared
 * capability source.
 */
import { SHARED_CAPABILITY_DESCRIPTION } from "../capabilities";
import { HelpGateArm } from "./helpGate";

/** Fixed greeting line the greeting arm prefixes (B7). */
export const CARD_GREETING_LINE = "Hi there!";

/** One-line "here's what I do" lead-in for the command/help arms (B7). */
export const CARD_LEAD_IN_LINE = "Here's what I do:";

/**
 * The per-surface ask line: teaches the Telegram way (plain text) and does
 * NOT re-list any command. Also the anti-spam test's card marker.
 */
export const CARD_ASK_LINE =
  "No slash commands work here — just ask me a question as a plain message.";

/** Example asks drawn from the plan's own arm corpus. */
export const CARD_EXAMPLES: ReadonlyArray<string> = [
  "How many days of annual leave do I have?",
  "What does the deploy script do?",
  "Show me the latest release notes",
];

/** The shared card body every arm renders (below the arm's lead-in line). */
function cardBody(): string {
  const examples = CARD_EXAMPLES.map((e) => `• ${e}`).join("\n");
  return [SHARED_CAPABILITY_DESCRIPTION, "", CARD_ASK_LINE, `For example:\n${examples}`].join("\n");
}

/**
 * Build the Telegram capability card for the arm that fired. Deterministic,
 * pure, and always well under the 4096-char message ceiling.
 */
export function buildHelpCard(arm: HelpGateArm): string {
  const lead = arm === "greeting" ? CARD_GREETING_LINE : CARD_LEAD_IN_LINE;
  return `${lead}\n\n${cardBody()}`;
}
