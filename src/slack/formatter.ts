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
 *   - bold+italic: `***x***` -> `*x*` (Slack has no combined bold+italic; bold is
 *               the closest single-mark rendering). Runs BEFORE the `**x**` rule so
 *               the 2-star pass cannot grab the inner pair. This ALSO fixes a
 *               heading whose text is bold — `# **Title**` heading-wraps to
 *               `***Title***`, which this 3-star rule then collapses to `*Title*`.
 *   - bold:     `**x**` -> `*x*` (NON-GREEDY, per-span — so `**a** and **b**`
 *               convert independently).
 *   - bold:     `__x__` -> `*x*`, EXCEPT when the inner span is a single bare
 *               identifier token (`/^\w+$/`): then it is left literal so Python
 *               dunders / intraword underscores survive — `__init__`, `__name__`,
 *               `obj.__init__()`, `snake__case`, `__123__`, `__GDP__` all stay as
 *               written. Multi-word spans (`__very important__`, anything with a
 *               space) still convert. The `**x**` rule is UNCHANGED (asterisk-bold
 *               has no identifier collision).
 *   - headings: a line `^#{1,6}\s+(.*)$` -> `*$1*` (per line; Slack has no headings).
 *   - links:    `[text](url)` -> `<url|text>`.
 *   - bullets:  a line starting `- ` or `* ` -> `• ` + the item text.
 *
 * Intentionally LEFT ALONE (accepted v1 cosmetic misses):
 *   - single `*x*` / `_x_` emphasis is untouched. `_x_` is already valid Slack
 *     italic; a stray Markdown `*italic*` renders as Slack bold — a far smaller
 *     miss than bold vanishing, and adding a single-`*`->`_` rule would clobber
 *     the `*x*` the bold pass just produced.
 *   - a single-word `__bold__` / `__123__` / `__GDP__` now stays LITERAL (the
 *     identifier-skip above can't tell a legit single-word bold from a dunder).
 *     Accepted v1 cosmetic miss — the LLM emits `**bold**` for that, which still
 *     converts correctly.
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
    // bold+italic: ***x*** -> *x* (Slack has no combined mark). MUST run before the
    // **x** rule so the 2-star pass doesn't grab the inner pair. Also collapses a
    // heading-wrapped bold title (`# **Title**` -> `***Title***` -> `*Title*`).
    .replace(/\*\*\*(.+?)\*\*\*/g, "*$1*")
    // bold: **x** -> *x* (non-greedy / per-span).
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    // bold: __x__ -> *x*, but SKIP a single bare identifier token (`/^\w+$/`) so
    // Python dunders / intraword underscores (`__init__`, `obj.__init__()`,
    // `snake__case`, `__123__`) are left literal. Multi-word spans still convert.
    .replace(/__(.+?)__/g, (m, inner) => (/^\w+$/.test(inner) ? m : `*${inner}*`));

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

/** A single tracked defect surfaced under a label-aware `/ask` answer (#1386). */
export interface AskDefectIssue {
  key: string;
  summary?: string;
}

/**
 * PURE formatter for the label-aware `/ask` defects block (#1386). Renders the
 * tagged-Jira defects an `/ask` question's named area resolved to, as blocks
 * APPENDED after the cited doc answer — so it NEVER perturbs the citation
 * numbering (`[1]…[N]`) or the abstain/refusal logic upstream.
 *
 * Layout (only when there are issues):
 *   1. Divider (separates the defects from the doc answer + citation list).
 *   2. Section block — `*Related tracked defects:*` followed by up to `max`
 *      `• KEY — summary` bullet lines, plus a trailing `…and N more` line when the
 *      matched issue count exceeds `max`.
 *
 * Emits NO `[N]` citation markers anywhere. Returns `[]` for empty/missing issues
 * (so no empty "Related defects" block is ever appended).
 */
export function formatAskDefectsBlocks(
  reply: { issues?: AskDefectIssue[] } | null | undefined,
  max: number = 5,
): SlackBlock[] {
  const issues = reply && Array.isArray(reply.issues) ? reply.issues : [];
  if (issues.length === 0) return [];

  const cap = Number.isFinite(max) && max >= 1 ? Math.floor(max) : issues.length;
  const shown = issues.slice(0, cap);
  const lines = shown.map((it) => {
    const key = sanitizeTitle(it.key ?? "");
    const summary =
      typeof it.summary === "string" && it.summary.length > 0
        ? ` — ${sanitizeTitle(it.summary)}`
        : "";
    return `• ${key}${summary}`;
  });

  const overflow = issues.length - shown.length;
  const bodyLines = ["*Related tracked defects:*", ...lines];
  if (overflow > 0) bodyLines.push(`…and ${overflow} more`);

  return [
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: truncate(bodyLines.join("\n"), MAX_SECTION_TEXT) },
    },
  ];
}
