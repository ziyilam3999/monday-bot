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
    expect.assertions(2);
    try {
      await ingestFile("test-fixtures/nope.xyz");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedFileTypeError);
      expect((err as Error).name).toBe("UnsupportedFileTypeError");
    }
  });

  it("rejects .markdown alias (contract is .md only)", async () => {
    expect.assertions(2);
    try {
      await ingestFile("test-fixtures/nope.markdown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedFileTypeError);
      expect((err as Error).name).toBe("UnsupportedFileTypeError");
    }
  });

  it("does not treat # lines inside fenced code blocks as headings", async () => {
    const path = require("path");
    const fs = require("fs");
    const os = require("os");
    const tmpFile = path.join(os.tmpdir(), "monday-fence-test.md");
    const content = [
      "# Real Heading",
      "",
      "Body paragraph.",
      "",
      "```bash",
      "# this is a shell comment, not a heading",
      "echo hi",
      "```",
      "",
      "More body.",
    ].join("\n");
    fs.writeFileSync(tmpFile, content);
    try {
      const chunks = await ingestFile(tmpFile);
      const headings = chunks.map((c) => c.heading).filter(Boolean);
      expect(headings).toEqual(["Real Heading"]);
      const hasShellComment = chunks.some((c) => c.text.includes("this is a shell comment"));
      expect(hasShellComment).toBe(true);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("strips UTF-8 BOM from TXT input without leaking into chunk text", async () => {
    const pathMod = require("path");
    const fs = require("fs");
    const os = require("os");
    const tmpFile = pathMod.join(os.tmpdir(), "monday-bom-test.txt");
    fs.writeFileSync(tmpFile, "\uFEFFhello world\n\nsecond paragraph");
    try {
      const chunks = await ingestFile(tmpFile);
      expect(chunks[0].text.startsWith("\uFEFF")).toBe(false);
      expect(chunks[0].text).toBe("hello world");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("strips UTF-8 BOM from Markdown input before parsing headings", async () => {
    const pathMod = require("path");
    const fs = require("fs");
    const os = require("os");
    const tmpFile = pathMod.join(os.tmpdir(), "monday-bom-test.md");
    fs.writeFileSync(tmpFile, "\uFEFF# Real Heading\n\nbody");
    try {
      const chunks = await ingestFile(tmpFile);
      const headings = chunks.map((c) => c.heading).filter(Boolean);
      expect(headings).toEqual(["Real Heading"]);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("does NOT treat the closing --- of YAML front matter as a setext heading underline", async () => {
    const pathMod = require("path");
    const fs = require("fs");
    const os = require("os");
    const tmpFile = pathMod.join(os.tmpdir(), "monday-yaml-front-matter.md");
    const content = [
      "---",
      "title: My Doc",
      "author: Alice",
      "---",
      "",
      "# Real content",
      "",
      "body paragraph",
    ].join("\n");
    fs.writeFileSync(tmpFile, content);
    try {
      const chunks = await ingestFile(tmpFile);
      const headings = chunks.map((c) => c.heading).filter(Boolean);
      expect(headings).not.toContain("author: Alice");
      expect(headings).not.toContain("title: My Doc");
      expect(headings).toContain("Real content");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("does NOT promote a list item trailer as a setext heading", async () => {
    const pathMod = require("path");
    const fs = require("fs");
    const os = require("os");
    const tmpFile = pathMod.join(os.tmpdir(), "monday-list-trailer.md");
    const content = ["- item one", "- item two", "---", "", "after"].join("\n");
    fs.writeFileSync(tmpFile, content);
    try {
      const chunks = await ingestFile(tmpFile);
      const headings = chunks.map((c) => c.heading).filter(Boolean);
      expect(headings).not.toContain("- item two");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("recognizes setext-style Markdown headings (=== for H1 and --- for H2)", async () => {
    const pathMod = require("path");
    const fs = require("fs");
    const os = require("os");
    const tmpFile = pathMod.join(os.tmpdir(), "monday-setext-test.md");
    const content = [
      "My Big Title",
      "============",
      "",
      "Intro paragraph.",
      "",
      "Subsection",
      "----------",
      "",
      "Subsection body.",
    ].join("\n");
    fs.writeFileSync(tmpFile, content);
    try {
      const chunks = await ingestFile(tmpFile);
      const headings = chunks.map((c) => c.heading).filter(Boolean);
      expect(headings).toContain("My Big Title");
      expect(headings).toContain("Subsection");
      expect(chunks.some((c) => c.text.includes("============"))).toBe(false);
      expect(chunks.some((c) => c.text.includes("----------"))).toBe(false);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("Markdown heading and section diverge: section tracks H1 only, heading tracks any level", async () => {
    const pathMod = require("path");
    const fs = require("fs");
    const os = require("os");
    const tmpFile = pathMod.join(os.tmpdir(), "monday-heading-section-divergence.md");
    const content = [
      "# Top Title",
      "",
      "intro paragraph",
      "",
      "## Sub Topic",
      "",
      "sub paragraph",
      "",
      "### Deeper",
      "",
      "deeper paragraph",
    ].join("\n");
    fs.writeFileSync(tmpFile, content);
    try {
      const chunks = await ingestFile(tmpFile);
      const intro = chunks.find((c) => c.text.includes("intro paragraph"))!;
      const sub = chunks.find((c) => c.text.includes("sub paragraph"))!;
      const deep = chunks.find((c) => c.text.includes("deeper paragraph"))!;
      expect(intro.heading).toBe("Top Title");
      expect(intro.section).toBe("Top Title");
      expect(sub.heading).toBe("Sub Topic");
      expect(sub.section).toBe("Top Title");
      expect(deep.heading).toBe("Deeper");
      expect(deep.section).toBe("Top Title");
      expect(sub.heading).not.toBe(sub.section);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
