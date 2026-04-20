import * as path from "path";
import { parseTxt } from "./parsers/txt";
import { parseMarkdown } from "./parsers/markdown";
import { parsePdf } from "./parsers/pdf";
import { parseDocx } from "./parsers/docx";

export interface Chunk {
  text: string;
  source: string;
  heading?: string;
  section?: string;
}

export class UnsupportedFileTypeError extends Error {
  constructor(ext: string, filePath: string) {
    super(
      `Unsupported file extension "${ext}" for ${filePath}. ` +
        `Monday ingests .txt, .md, .pdf, and .docx files.`
    );
    this.name = "UnsupportedFileTypeError";
  }
}

export async function ingestFile(filePath: string): Promise<Chunk[]> {
  const ext = path.extname(filePath).toLowerCase();
  const absSource = path.resolve(filePath);

  let rawChunks: Chunk[];
  switch (ext) {
    case ".txt":
      rawChunks = await parseTxt(filePath, absSource);
      break;
    case ".md":
      rawChunks = await parseMarkdown(filePath, absSource);
      break;
    case ".pdf":
      rawChunks = await parsePdf(filePath, absSource);
      break;
    case ".docx":
      rawChunks = await parseDocx(filePath, absSource);
      break;
    default:
      throw new UnsupportedFileTypeError(ext, filePath);
  }

  return rawChunks.filter((c) => c.text && c.text.trim().length > 0);
}
