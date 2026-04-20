import * as fs from "fs/promises";
import type { Chunk } from "../ingest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

export async function parsePdf(filePath: string, source: string): Promise<Chunk[]> {
  const buffer = await fs.readFile(filePath);
  const data = new Uint8Array(buffer);

  const loadingTask = pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false });
  const doc = await loadingTask.promise;

  const chunks: Chunk[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: unknown) => {
        const it = item as { str?: string };
        return typeof it.str === "string" ? it.str : "";
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (pageText.length > 0) {
      chunks.push({ text: pageText, source, section: `page-${pageNum}` });
    }
  }

  await doc.destroy();
  return chunks;
}
