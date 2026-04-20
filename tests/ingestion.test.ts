import * as path from "path";
import { ingestFile, UnsupportedFileTypeError } from "../src/ingestion/ingest";

const fixturesDir = path.resolve(__dirname, "..", "test-fixtures");
const fx = (name: string) => path.join(fixturesDir, name);

describe("ingestFile", () => {
  it("parses a TXT file into at least one chunk with text and source", async () => {
    const chunks = await ingestFile(fx("sample.txt"));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text.trim().length).toBeGreaterThan(0);
    expect(chunks[0].source).toContain("sample.txt");
  });

  it("parses a Markdown file with heading metadata on section chunks", async () => {
    const chunks = await ingestFile(fx("sample.md"));
    expect(chunks.length).toBeGreaterThan(0);
    const withHeading = chunks.filter((c) => c.heading || c.section);
    expect(withHeading.length).toBeGreaterThan(0);
  });

  it("parses a PDF file into chunks with non-empty text", async () => {
    const chunks = await ingestFile(fx("sample.pdf"));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text.trim().length).toBeGreaterThan(0);
  });

  it("parses a DOCX file into chunks with non-empty text", async () => {
    const chunks = await ingestFile(fx("sample.docx"));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text.trim().length).toBeGreaterThan(0);
  });

  it("never emits empty or whitespace-only chunks", async () => {
    const all = await Promise.all([
      ingestFile(fx("sample.txt")),
      ingestFile(fx("sample.md")),
      ingestFile(fx("sample.pdf")),
      ingestFile(fx("sample.docx")),
    ]);
    const bad = all.flat().filter((c) => !c.text || !c.text.trim());
    expect(bad.length).toBe(0);
  });

  it("rejects unsupported file extensions", async () => {
    await expect(ingestFile("test-fixtures/nope.xyz")).rejects.toBeInstanceOf(
      UnsupportedFileTypeError
    );
  });
});
