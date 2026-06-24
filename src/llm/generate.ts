import { getClient } from "./anthropicClient";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;

export const SYSTEM_PROMPT =
  "You answer factually from the provided context only. " +
  "Lead with what you DID find in the context and cite it with inline [N] citations that map to the numbered sources in the context block; " +
  "only after stating what you found, note any remaining gap. " +
  "CRITICAL: whenever the context contains ANY material RELEVANT to the question, your answer MUST OPEN with what IS covered (and cite it [N]); state what is missing ONLY AFTER that. " +
  "You must NOT open with \"I couldn't find...\" whenever the context holds relevant material — that opener is RESERVED ONLY for the case where the context is genuinely off-topic and contains NO relevant information at all. " +
  "GOOD (relevant context): \"The Initial Setup doc [1] covers Flutter, Riverpod, themes, and API setup; there isn't a separate step-by-step local-env guide in the docs.\" " +
  "BAD (relevant context, wrong opener): \"I couldn't find specific instructions... but the context includes a checklist [1].\" " +
  "ABSTAIN (off-topic context, no relevant material): say you couldn't find any relevant information, with no citations. " +
  "PROCESS/SPEC DOCS COUNT AS GROUNDING: when the context contains a doc passage that describes the relevant PROCESS, MECHANISM, business rules, or spec for what is asked — even if it is NOT a step-by-step click-by-click user tutorial — treat it as grounding material: lead with what the documented process IS and cite it [N], then (only after) note that this is the documented process rather than a tap-by-tap UI walkthrough. " +
  "Passages framed as BUSINESS RULES, specs, change-logs, internal-reference notes, or backend/engineering tickets STILL count as grounding when they describe the STEPS, FLOW, or MECHANISM of what the user asked about. Do NOT refuse merely because the material is framed as internal/backend/business-rules rather than a polished end-user guide — translate the documented flow into plain user-facing steps and cite [N]. For example, if the question is how to find/do something and a passage describes the matching/selection/decision flow for exactly that, EXPLAIN that flow as the answer instead of saying there are no user-facing instructions. " +
  "This process/spec clause applies ONLY when that passage is genuinely ON-TOPIC and relevant to the exact question asked; a process or spec passage that is about a DIFFERENT topic than the question is NOT grounding for that question — do not cite it, and abstain if nothing on-topic remains. " +
  "SINGLE-PRODUCT KNOWLEDGE BASE: every passage here is about ONE product, so the ABSENCE of the product's or a feature's NAME (a brand or proper-noun) from the passages is MEANINGLESS — a missing brand word does NOT mean the topic is uncovered, and you must NEVER open with \"I couldn't find\" merely because the exact product or feature name from the question is not present verbatim in the passages. Decide grounding ONLY on whether the passages genuinely DESCRIBE THE TOPIC OR FEATURE the question asks about: if any passage describes that topic's mechanism, flow, rules, locations, or plans — even partially, even as a roadmap or backend/spec note — you MUST lead with that documented answer and cite [N], not prepend a hedge, even though the passage never names the product. The ONLY exception is the no-yes-man clamp: a passage that merely mentions or is generally about the product but does NOT address the specific topic asked is NOT grounding — only in that case do you cleanly decline with no citations. This clause removes ONLY proper-noun ABSENCE as a disqualifier; the existing genuinely ON-TOPIC precondition above still governs — it does NOT relax the requirement that the passage be on-topic to the exact question asked. " +
  "When you abstain, your reply MUST contain NO [N] citation markers at all — never cite a loosely-related passage while saying you couldn't find the answer. " +
  "PREFER DOCS OVER TICKET STUBS: when both narrative/document sources and bare issue-tracker ticket stubs cover the same topic, build your answer from and cite the document/narrative passages, not bare ticket titles. " +
  "PHASED / PLANNED ROLLOUTS: when the relevant doc describes a PLANNED or PHASED rollout or roadmap, answer with what is LIVE now and what is NAMED-planned and cite the doc [N]; do NOT dismiss a roadmap as \"no comprehensive list.\" " +
  "Never cite outside the numbered list. " +
  "If the context contains no relevant information, say you couldn't find the information (a clean refusal with no citations). " +
  "Keep answers concise (target 50-400 words) and suitable for a Slack message.";

export const NO_CONTEXT_ANSWER =
  "I couldn't find any relevant information in the indexed documents to answer this question.";

/**
 * Pure helper: return ONLY the citations whose `number` actually appears as an
 * inline `[N]` marker in `answer`, keeping their original numbers and order.
 *
 * - Parses the distinct `[N]` markers present in the answer text.
 * - If no `[N]` markers appear (e.g. refusals / NO_CONTEXT_ANSWER), returns [].
 * - Defensive: non-string `answer` or non-array `citations` -> [].
 */
export function selectCitedCitations(
  answer: string,
  citations: Citation[],
): Citation[] {
  if (typeof answer !== "string" || !Array.isArray(citations)) return [];
  const cited = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    cited.add(Number(m[1]));
  }
  if (cited.size === 0) return [];
  return citations.filter((c) => cited.has(c.number));
}

/**
 * Deterministic post-processor for abstention replies.
 *
 * If `answer` OPENS with an abstain phrase ("I couldn't find ...", anchored at
 * start, leading whitespace tolerated, case-insensitive, optional/typographic
 * apostrophe), then: (a) remove every inline `[N]` marker and tidy the leftover
 * spacing, and (b) force `citations` to `[]`. Otherwise return both unchanged.
 *
 * The opener guard is the control: a grounded reply that LEADS with content and
 * only later notes a gap does NOT open with the phrase, so it is untouched.
 *
 * Defensive: a non-string `answer` cannot match the opener -> returned unchanged
 * (no throw, citations normalized to `[]` only when non-array); the type guard
 * runs BEFORE any regex/`.replace` so `undefined` answers never throw.
 */
export function stripStrayAbstainCitations(
  answer: string,
  citations: Citation[],
): AnswerResult {
  if (typeof answer !== "string") {
    return { answer, citations: Array.isArray(citations) ? citations : [] };
  }
  if (!/^\s*I couldn['’]?t find/i.test(answer)) {
    return { answer, citations };
  }
  const cleaned = answer
    .replace(/\s*\[\d+\]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return { answer: cleaned, citations: [] };
}

/**
 * Offline / test-mode flag. When set (or when no Anthropic credentials are
 * available at runtime), `generateAnswer` returns a deterministic fallback
 * answer assembled from the top retrieved chunks instead of calling the LLM.
 *
 * The fallback still exercises the full retrieval+citation pipeline — it only
 * replaces the LLM call. This lets the US-12 e2e ACs run without live API
 * credentials while keeping production behavior unchanged when creds exist.
 */
function isTestMode(): boolean {
  return process.env.MONDAY_TEST_MODE === "1";
}

/**
 * Deterministic offline answer: concatenate the first 1-2 top chunks' text,
 * bolt a `[1]` citation onto the end, and return the canonical citation array.
 * Preserves the contract of `generateAnswer` (same shape, same citation order).
 */
function offlineAnswer(chunks: Chunk[]): AnswerResult {
  const top = chunks.slice(0, 2);
  const body = top
    .map((c) => c.text.trim())
    .filter((t) => t.length > 0)
    .join(" ")
    .trim();
  const answer =
    body.length > 0
      ? `${body} [1]`
      : NO_CONTEXT_ANSWER;
  return {
    answer,
    citations: selectCitedCitations(answer, buildCitations(chunks)),
  };
}

export interface Chunk {
  id: string;
  text: string;
  source: string;
  heading?: string;
  section?: string;
  score?: number;
}

export interface Citation {
  number: number;
  source: string;
  heading?: string;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
}

function formatContext(chunks: Chunk[]): string {
  return chunks
    .map((c, i) => {
      const n = i + 1;
      const meta = c.heading
        ? `(source: ${c.source}, heading: ${c.heading})`
        : `(source: ${c.source})`;
      return `[${n}] ${meta}\n${c.text}`;
    })
    .join("\n\n");
}

function buildCitations(chunks: Chunk[]): Citation[] {
  return chunks.map((c, i) => {
    const entry: Citation = { number: i + 1, source: c.source };
    if (c.heading) entry.heading = c.heading;
    return entry;
  });
}

export async function generateAnswer(
  question: string,
  chunks: Chunk[],
): Promise<AnswerResult> {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { answer: NO_CONTEXT_ANSWER, citations: [] };
  }

  // Test-mode short-circuit: skip the LLM entirely and return a deterministic
  // answer assembled from the top chunks. Also used as a graceful fallback
  // when Anthropic credentials are missing (e.g. CI without secrets).
  if (isTestMode()) {
    return offlineAnswer(chunks);
  }

  let client;
  try {
    client = getClient();
  } catch (err) {
    // No credentials: degrade gracefully to offline mode rather than crashing
    // the whole pipeline. Real production deployments will have OAuth or
    // ANTHROPIC_API_KEY configured; this branch is the e2e safety net.
    console.warn(
      `[generateAnswer] no Anthropic credentials, returning offline answer: ${(err as Error).message}`,
    );
    return offlineAnswer(chunks);
  }

  const context = formatContext(chunks);
  const userContent =
    `Question: ${question}\n\n` +
    `Context:\n${context}\n\n` +
    `Answer the question using only facts from the context. Cite each claim with [N].`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // temperature 0: the ground-vs-abstain drift on the same question was a
    // high-temperature coin-flip (#1195). Deterministic decoding stabilizes the
    // answer so a correct prompt grounds consistently and a wrong one fails
    // consistently (detectable), instead of flip-flopping run-to-run.
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("")
    .trim();

  if (text.length === 0) {
    const blockTypes = response.content.map((block) => block.type);
    console.warn(
      `[generateAnswer] model returned non-text-only response: block_types=${JSON.stringify(blockTypes)} stop_reason=${response.stop_reason ?? "unknown"}`,
    );
    return { answer: NO_CONTEXT_ANSWER, citations: [] };
  }

  return stripStrayAbstainCitations(
    text,
    selectCitedCitations(text, buildCitations(chunks)),
  );
}
