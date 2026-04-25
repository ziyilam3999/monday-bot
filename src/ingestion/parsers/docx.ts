import mammoth from "mammoth";
import type { Chunk } from "../ingest";

export async function parseDocx(filePath: string, source: string): Promise<Chunk[]> {
  const result = await mammoth.extractRawText({ path: filePath });
  if (process.env.MONDAY_DEBUG === "1" && result.messages && result.messages.length > 0) {
    for (const m of result.messages) {
      console.warn(`mammoth ${m.type ?? "warn"}: ${m.message ?? String(m)} (${source})`);
    }
  }
  const text = result.value.trim();

  if (text.length === 0) {
    return [];
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) {
    return [{ text, source }];
  }

  return paragraphs.map((para) => ({ text: para, source }));
}
