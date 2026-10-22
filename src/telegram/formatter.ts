/**
 * #3277 — pure formatters for the Telegram reply path. Reuses the Slack query
 * handler's payload (`{ text, blocks? }`) — `text` is the handler's answer
 * fallback field, citation context blocks carry `*[n]* source — heading` lines.
 */
import { QueryHandlerResult } from "../slack/queryHandler";

const DEFAULT_MESSAGE_LIMIT = 4096; // Telegram sendMessage text ceiling.

/** Strip mrkdwn emphasis pairs (`*x*` → `x`) so plain text carries no stray asterisks. */
function stripMrkdwn(s: string): string {
  return s.replace(/\*([^*]+)\*/g, "$1");
}

/**
 * #3324 — undo the Slack escaping on citation titles at the Slack→Telegram
 * boundary. Slack's `sanitizeTitle` escapes `& < >` because Slack's API
 * requires it (and Slack decodes on display); Telegram sends plain text with
 * no parse_mode, so nothing there ever decodes them and users saw raw
 * `&amp;`/`&lt;` in Sources lines. This is the exact inverse of that encode
 * set — `&amp;` LAST, mirroring the encode order — applied once per string,
 * so a title whose source text literally contains `&amp;` round-trips
 * byte-identically (`&` → `&amp;amp;` → `&amp;`). Sequences outside the
 * encode set (`&quot;`, `&#39;`, …) are never decoded: they were never
 * encoded, so touching them would corrupt source text.
 */
function decodeSlackEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Render a query-handler payload as Telegram plain text: the answer body plus,
 * when citation context blocks are present, their lines under a `Sources:`
 * separator (mrkdwn emphasis stripped).
 */
export function renderTelegramReply(payload: QueryHandlerResult): string {
  const body = stripMrkdwn(typeof payload?.text === "string" ? payload.text : "");
  const citationLines: string[] = [];
  for (const block of payload?.blocks ?? []) {
    if (block.type !== "context") continue;
    for (const element of block.elements ?? []) {
      if (typeof element?.text === "string" && element.text.length > 0) {
        // #3324 — decode the Slack escapes on every context-element text as a
        // class (source, heading, any future citation line), never the body.
        citationLines.push(decodeSlackEntities(stripMrkdwn(element.text)));
      }
    }
  }
  if (citationLines.length === 0) return body;
  return `${body}\n\nSources:\n${citationLines.join("\n")}`;
}

/**
 * Split `text` into parts each ≤ `limit` chars (default 4096 — Telegram's
 * message ceiling). Prefers the last newline before the limit; hard-slices
 * when no newline exists. The concatenation of the parts always preserves the
 * input byte-for-byte (the newline a part splits on is kept in that part).
 */
export function splitMessage(text: string, limit: number = DEFAULT_MESSAGE_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const newline = window.lastIndexOf("\n");
    const cut = newline >= 0 ? newline + 1 : limit; // keep the newline in the part
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}
