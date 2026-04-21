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

  const client = getClient();
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

  return {
    answer: text,
    citations: buildCitations(chunks),
  };
}
