import * as fs from "fs/promises";
import type { Chunk } from "../ingest";

export async function parseTxt(filePath: string, source: string): Promise<Chunk[]> {
  let raw = await fs.readFile(filePath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const paragraphs = raw
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) {
    return [];
  }

  return paragraphs.map((text) => ({ text, source }));
}
