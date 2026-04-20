import * as fs from "fs/promises";
import type { Chunk } from "../ingest";

export async function parseMarkdown(filePath: string, source: string): Promise<Chunk[]> {
  const raw = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);

  const chunks: Chunk[] = [];
  let currentHeading: string | undefined;
  let buffer: string[] = [];
  let inCodeFence = false;

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text.length > 0) {
      const chunk: Chunk = { text, source };
      if (currentHeading) {
        chunk.heading = currentHeading;
        chunk.section = currentHeading;
      }
      chunks.push(chunk);
    }
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeFence = !inCodeFence;
      buffer.push(line);
      continue;
    }

    if (!inCodeFence) {
      const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (headingMatch) {
        flush();
        currentHeading = headingMatch[2];
        continue;
      }
    }

    buffer.push(line);
  }
  flush();

  return chunks;
}
