import {
  AVAILABLE_COMMANDS,
  REGISTRY_COMMAND_TOKENS,
  SHARED_CAPABILITY_DESCRIPTION,
  renderSlackHelp,
} from "../src/capabilities";
import { helpCommand, AdminService } from "../src/slack/commands";
import {
  CARD_ASK_LINE,
  CARD_EXAMPLES,
  CARD_GREETING_LINE,
  CARD_LEAD_IN_LINE,
  buildHelpCard,
} from "../src/telegram/helpCard";

/**
 * #3306 — AC-7: ONE shared capability source, no drift, truthful per surface.
 * Identity is pinned BY CONSTRUCTION: the test imports the shared module and
 * both surfaces directly — never a substring slice of `helpCommand()` prose.
 */

/** The pre-#3306 `/help` text, byte-for-byte — the golden string (AC-7a). */
const GOLDEN_SLACK_HELP = [
  "Available commands:",
  "• /ask <question> — Ask the bot a question against the indexed docs.",
  "• /status-monday — Show document count and uptime.",
  "• /sync-confluence [space] — Trigger a fresh sync of the Confluence space.",
  "• /reindex — Re-index all Confluence pages and Jira issues.",
  "• /jql <question> — Turn an English defect question into JQL and show the matching defects.",
  "• /help — Show this help message.",
  "• /feedback-monday <message> — Send feedback to the bot maintainers.",
].join("\n");

describe("AC-7a — Slack /help stays byte-identical, rendered from the shared registry", () => {
  it("helpCommand() output equals the golden pre-change string", () => {
    expect(helpCommand({} as AdminService)).toBe(GOLDEN_SLACK_HELP);
  });

  it("helpCommand() output equals the shared renderer's output (delegation, by construction)", () => {
    expect(helpCommand({} as AdminService)).toBe(renderSlackHelp());
  });

  it("the shared registry still carries all seven commands", () => {
    expect(AVAILABLE_COMMANDS.map((c) => c.name)).toEqual([
      "/ask <question>",
      "/status-monday",
      "/sync-confluence [space]",
      "/reindex",
      "/jql <question>",
      "/help",
      "/feedback-monday <message>",
    ]);
  });
});

describe("AC-7b — the Telegram card's capability description is the ONE shared description", () => {
  for (const arm of ["command", "greeting", "help"] as const) {
    it(`the ${arm} card embeds SHARED_CAPABILITY_DESCRIPTION byte-identically`, () => {
      expect(buildHelpCard(arm)).toContain(SHARED_CAPABILITY_DESCRIPTION);
    });
  }
});

describe("AC-7c — the Telegram card teaches no command that does not work there", () => {
  for (const arm of ["command", "greeting", "help"] as const) {
    it(`the ${arm} card contains no registry command token`, () => {
      const card = buildHelpCard(arm);
      for (const token of REGISTRY_COMMAND_TOKENS) {
        expect(card).not.toContain(token);
      }
    });
  }

  it("the card never says Sources: and never cites anything", () => {
    for (const arm of ["command", "greeting", "help"] as const) {
      expect(buildHelpCard(arm)).not.toContain("Sources:");
    }
  });
});

describe("AC-7 shape — arm lead-ins and examples", () => {
  it("the greeting arm prefixes the fixed greeting line; the others the lead-in line", () => {
    expect(buildHelpCard("greeting").startsWith(`${CARD_GREETING_LINE}\n\n`)).toBe(true);
    expect(buildHelpCard("command").startsWith(`${CARD_LEAD_IN_LINE}\n\n`)).toBe(true);
    expect(buildHelpCard("help").startsWith(`${CARD_LEAD_IN_LINE}\n\n`)).toBe(true);
  });

  it("every card carries the ask-in-plain-text line and the examples", () => {
    for (const arm of ["command", "greeting", "help"] as const) {
      const card = buildHelpCard(arm);
      expect(card).toContain(CARD_ASK_LINE);
      for (const example of CARD_EXAMPLES) {
        expect(card).toContain(`• ${example}`);
      }
    }
  });

  it("the card is plain text well under the Telegram message ceiling", () => {
    for (const arm of ["command", "greeting", "help"] as const) {
      expect(buildHelpCard(arm).length).toBeLessThan(4096);
    }
  });
});
