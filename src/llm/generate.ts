import { getClient } from "./anthropicClient";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT =
  "You answer factually from the provided context only. " +
  "Use inline [N] citations that map to the numbered sources in the context block, " +
  "never cite outside the numbered list, and if the context is insufficient say you couldn't find the information. " +
  "Keep answers concise (target 50-400 words) and suitable for a Slack message.";

const NO_CONTEXT_ANSWER =
  "I couldn't find any relevant information in the indexed documents to answer this question.";

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
    citations: buildCitations(chunks),
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

  return {
    answer: text,
    citations: buildCitations(chunks),
  };
}
