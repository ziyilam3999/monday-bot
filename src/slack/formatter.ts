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

  const answer = input.answer.trim();
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
      const heading = typeof c.heading === "string" && c.heading.length > 0 ? ` — ${c.heading}` : "";
      return {
        type: "mrkdwn",
        text: `*[${n}]* ${c.source}${heading}`,
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
