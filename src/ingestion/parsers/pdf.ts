import * as fs from "fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.js";
import type { Chunk } from "../ingest";

export async function parsePdf(filePath: string, source: string): Promise<Chunk[]> {
  const buffer = await fs.readFile(filePath);
  const data = new Uint8Array(buffer);

  const loadingTask = pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false });
  let doc!: Awaited<typeof loadingTask.promise>;
  try {
    doc = await loadingTask.promise;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "PasswordException") {
      throw new Error(`${filePath} is password-protected`);
    }
    throw err;
  }

  try {
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
    return chunks;
  } finally {
    await doc.destroy();
  }
}
