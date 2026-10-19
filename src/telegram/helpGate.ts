/**
 * #3306 — PURE pre-retrieval help-card gate for the Telegram reply path
 * (zero LLM, zero retrieval, zero network). Mirrors the two deterministic
 * routers already shipped: `classifyMentionIntent` (#1344) and the #3299
 * exact-key leg. The safe default is ALWAYS the doc route — today's behaviour —
 * so any ambiguity falls through to `handleQuery` untouched.
 *
 * Gate order (B2), first match wins — all three arms yield the same card:
 *   1. unknown slash command   (B4)
 *   2. short greeting          (B5)
 *   3. whole-message help probe (B6)
 *
 * Normalization (B3) is GATE-INTERNAL ONLY: on any non-match the caller keeps
 * the ORIGINAL trimmed text byte-for-byte — nothing here ever leaks into the
 * query (the #3299 parity convention).
 */
import { ARGUMENT_TAKING_COMMAND_WORDS } from "../capabilities";

/** Which arm of the gate fired. */
export type HelpGateArm = "command" | "greeting" | "help";

export interface HelpGateResult {
  /** true → reply with the capability card; false → today's doc path. */
  card: boolean;
  /** The arm that fired, or null on a non-match. */
  arm: HelpGateArm | null;
}

/** Greeting lexicon (B5, fixed and exported per B10). */
export const GREETING_LEXICON: ReadonlySet<string> = new Set([
  "hi",
  "hello",
  "hey",
  "hiya",
  "howdy",
  "yo",
  "sup",
  "greetings",
  "good",
  "morning",
  "afternoon",
  "evening",
]);

/**
 * Greeting filler (vocative-adjacent words, never question content), PLUS the
 * bot's own name token(s) — "hello monday" addresses the bot, so the name is
 * a vocative (r2 fix for MAJOR 2). The @-mention form needs no entry at all:
 * B3 drops "@"-prefixed tokens before counting.
 */
export const BOT_NAME_TOKENS: ReadonlyArray<string> = ["monday", "monday-bot"];
export const GREETING_FILLER: ReadonlySet<string> = new Set([
  "there",
  "everyone",
  "everybody",
  "team",
  "folks",
  "all",
  "again",
  "bot",
  ...BOT_NAME_TOKENS,
]);

/** Whole-message help-probe phrases (B6, exact equality after normalization). */
export const HELP_PROBE_PHRASES: ReadonlyArray<string> = [
  "help",
  "commands",
  "what can you do",
  "what do you do",
  "how does this work",
];

/** Telegram command-token shape (B4): one "/word", optional single @suffix. */
const COMMAND_TOKEN_RE = /^\/([A-Za-z][A-Za-z0-9_-]*)(@[A-Za-z0-9_]+)?$/;
/** Max length of the command word INCLUDING the leading slash (Telegram syntax). */
const MAX_COMMAND_LENGTH = 32;
/** Trailing sentence punctuation stripped from the raw first token (B4). */
const TRAILING_PUNCTUATION = /[!?.,…]+$/;

/** The B3 countable tokens: split on whitespace, drop @-mentions, strip
 * non-alphanumerics from both ENDS of each token, drop what strips to empty. */
function countableTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.split(/\s+/)) {
    if (raw.length === 0 || raw.startsWith("@")) continue; // a mention is a vocative
    const stripped = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (stripped.length === 0) continue; // pure emoji/punctuation token
    tokens.push(stripped.toLowerCase());
  }
  return tokens;
}

/** B4: does the raw first token look like a Telegram slash command? */
function commandWordOrNull(rawFirstToken: string): string | null {
  const lowered = rawFirstToken.toLowerCase().replace(TRAILING_PUNCTUATION, "");
  const match = lowered.match(COMMAND_TOKEN_RE);
  if (!match) return null;
  if (match[1].length + 1 > MAX_COMMAND_LENGTH) return null;
  return `/${match[1]}`;
}

/** B5: short greeting — ≤3 countable tokens, ≥1 lexicon word, ALL tokens
 * lexicon ∪ filler (the all-tokens rule is what keeps greeting-prefixed real
 * questions on the doc path). */
function isShortGreeting(tokens: string[]): boolean {
  if (tokens.length === 0 || tokens.length > 3) return false;
  if (!tokens.some((t) => GREETING_LEXICON.has(t))) return false;
  return tokens.every((t) => GREETING_LEXICON.has(t) || GREETING_FILLER.has(t));
}

/** B6: whole-message help probe — the joined normalized message EQUALS one of
 * the probe phrases (never substring, never prefix). */
function isHelpProbe(tokens: string[]): boolean {
  return HELP_PROBE_PHRASES.includes(tokens.join(" "));
}

/**
 * Classify one (already-trimmed) message text. PURE and total: never throws,
 * never reads I/O, and returns `{ card: false, arm: null }` for anything that
 * should keep today's byte-identical doc path.
 */
export function classifyHelpGate(text: string): HelpGateResult {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length === 0) return { card: false, arm: null };

  // B4 — unknown slash command. Checked on the RAW first whitespace token
  // (lowercased, trailing sentence punctuation stripped, optional @suffix
  // removed) BEFORE end-stripping: end-stripping would eat the leading "/".
  if (trimmed.startsWith("/")) {
    const rawFirst = trimmed.split(/\s+/)[0];
    const commandWord = commandWordOrNull(rawFirst);
    if (commandWord !== null) {
      const remainder = trimmed.slice(rawFirst.length).trim();
      const carriesPayload =
        ARGUMENT_TAKING_COMMAND_WORDS.has(commandWord.slice(1)) && remainder.length > 0;
      if (!carriesPayload) return { card: true, arm: "command" };
      // Registry command WITH its payload: a real question today → doc path.
    }
    // Anything else with a leading slash (paths "/etc/hosts", "/api/v1/…",
    // multi-slash tokens) is NOT command-shaped → fall through to the doc path.
  }

  const tokens = countableTokens(trimmed);
  if (isShortGreeting(tokens)) return { card: true, arm: "greeting" };
  if (isHelpProbe(tokens)) return { card: true, arm: "help" };
  return { card: false, arm: null };
}
