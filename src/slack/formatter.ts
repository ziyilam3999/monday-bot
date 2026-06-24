/**
 * Slack Block Kit formatter for KnowledgeService answers.
 *
 * Platform-agnostic: imports nothing from Slack SDKs. Takes the answer payload
 * shape produced by `KnowledgeService.query` (or any equivalent) and returns a
 * `chat.postMessage`-compatible `{ blocks, text }` payload.
 *
 * Citation shape is liberal — accepts either `{ num, source }` (per US-08 AC)
 * or `{ number, source }` (the canonical `Citation` shape from `src/llm/generate.ts`).
 * Either works; both render identically.
 */

export interface FormatterCitationInput {
  num?: number;
  number?: number;
  source: string;
  heading?: string;
}

export interface FormatAnswerInput {
  answer: string;
  citations?: FormatterCitationInput[];
}

export interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
}

export interface SlackSectionBlock {
  type: "section";
  text: SlackTextObject;
}

export interface SlackContextBlock {
  type: "context";
  elements: SlackTextObject[];
}

export interface SlackDividerBlock {
  type: "divider";
}

export type SlackBlock = SlackSectionBlock | SlackContextBlock | SlackDividerBlock;

export interface SlackMessagePayload {
  blocks: SlackBlock[];
  /** Fallback text used by Slack for notifications and accessibility. */
  text: string;
}

const MAX_SECTION_TEXT = 2900; // Slack section text limit is 3000; leave headroom.

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…"; // ellipsis
}

function citationNumber(c: FormatterCitationInput): number {
  if (typeof c.num === "number") return c.num;
  if (typeof c.number === "number") return c.number;
  return 0;
}

/**
 * Sanitize a source/heading title for safe rendering inside a Slack mrkdwn
 * context line. Escapes Slack's required HTML chars (`& < >`, in that order)
 * and strips the emphasis/code chars (`* ~` and backtick) that break layout
 * when they appear unbalanced (e.g. a stray `**`). Underscore is left intact —
 * it is legitimate in filenames and only italicizes in matched pairs.
 */
function sanitizeTitle(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[*~`]/g, "");
}

/**
 * Convert CommonMark-style Markdown (as emitted by the LLM) into Slack mrkdwn.
 *
 * Slack mrkdwn is a different dialect from standard Markdown: bold is a single
 * `*` (not `**`), links are `<url|text>` (not `[text](url)`), and there are no
 * `#` headings. The LLM emits standard Markdown, so dropping it straight into a
 * Slack `mrkdwn` block renders literal asterisks. This deterministic, pure v1
 * converter handles the common cases an LLM answer produces.
 *
 * Conversions:
 *   - bold:     `**x**` and `__x__` -> `*x*` (NON-GREEDY, per-span — so
 *               `**a** and **b**` convert independently). The ONLY emphasis rule.
 *   - headings: a line `^#{1,6}\s+(.*)$` -> `*$1*` (per line; Slack has no headings).
 *   - links:    `[text](url)` -> `<url|text>`.
 *   - bullets:  a line starting `- ` or `* ` -> `• ` + the item text.
 *
 * Intentionally LEFT ALONE (accepted v1 cosmetic misses):
 *   - single `*x*` / `_x_` emphasis is untouched. `_x_` is already valid Slack
 *     italic; a stray Markdown `*italic*` renders as Slack bold — a far smaller
 *     miss than bold vanishing, and adding a single-`*`->`_` rule would clobber
 *     the `*x*` the bold pass just produced.
 *   - `~strike~`, citation tokens like `[2]` (no parens -> not a link), plain text.
 *
 * Known v1 LIMITATION: inline/fenced code spans are NOT masked, so a `**` inside
 * a `` `code` `` span IS converted. Acceptable for v1 (rare in answer bodies).
 */
export function markdownToMrkdwn(s: string): string {
  if (typeof s !== "string") return s;

  // Per-line: headings and bullets operate on the raw line markers.
  const out = s
    .split("\n")
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) return `*${heading[1]}*`;
      const bullet = line.match(/^[-*] (.*)$/);
      if (bullet) return `• ${bullet[1]}`;
      return line;
    })
    .join("\n")
    // links: [text](url) -> <url|text> (a bare `[2]` citation has no `(...)`).
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
    // bold: **x** and __x__ -> *x* (non-greedy / per-span). The ONLY emphasis rule.
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*");

  return out;
}

/**
 * Format a `{ answer, citations }` payload into a Slack Block Kit message.
 *
 * Layout:
 *   1. Section block — answer text (mrkdwn)
 *   2. Divider (only when there are citations)
 *   3. Context block — `[N] source` lines, one element per citation
 */
export function formatAnswer(input: FormatAnswerInput): SlackMessagePayload {
  if (!input || typeof input !== "object") {
    throw new TypeError("formatAnswer: input must be an object");
  }
  if (typeof input.answer !== "string") {
    throw new TypeError("formatAnswer: input.answer must be a string");
  }

  // Convert ONCE here so both the section block and the fallback `text` field
  // below use the same Slack-mrkdwn string (consistent; no `**` in either).
  const answer = markdownToMrkdwn(input.answer.trim());
  const citations = Array.isArray(input.citations) ? input.citations : [];

  const blocks: SlackBlock[] = [];

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncate(answer.length > 0 ? answer : "_(no answer)_", MAX_SECTION_TEXT),
    },
  });

  if (citations.length > 0) {
    blocks.push({ type: "divider" });

    const lines: SlackTextObject[] = citations.map((c) => {
      const n = citationNumber(c);
      const heading =
        typeof c.heading === "string" && c.heading.length > 0
          ? ` — ${sanitizeTitle(c.heading)}`
          : "";
      return {
        type: "mrkdwn",
        text: `*[${n}]* ${sanitizeTitle(c.source)}${heading}`,
      };
    });

    // Slack caps a context block at 10 elements; chunk if needed.
    const CHUNK = 10;
    for (let i = 0; i < lines.length; i += CHUNK) {
      blocks.push({
        type: "context",
        elements: lines.slice(i, i + CHUNK),
      });
    }
  }

  return {
    blocks,
    text: truncate(answer.length > 0 ? answer : "(no answer)", 1000),
  };
}
