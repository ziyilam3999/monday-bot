import * as fs from "fs/promises";
import type { Chunk } from "../ingest";

export async function parseMarkdown(filePath: string, source: string): Promise<Chunk[]> {
  let raw = await fs.readFile(filePath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

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

      // Setext heading: non-blank text line immediately followed by === or ---.
      // Also requires the PREVIOUS line to be blank (or start of file) so YAML
      // front matter, list-item trailers, and paragraph continuations don't
      // promote their tail line to a heading.
      const next = lines[i + 1];
      const prevIsBlank = i === 0 || lines[i - 1].trim() === "";
      if (
        prevIsBlank &&
        line.trim().length > 0 &&
        next !== undefined &&
        (/^=+\s*$/.test(next) || /^-+\s*$/.test(next))
      ) {
        flush();
        currentHeading = line.trim();
        i++;
        continue;
      }
    }

    buffer.push(line);
  }
  flush();

  return chunks;
}
