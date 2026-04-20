/* eslint-disable */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { Document, Packer, Paragraph, HeadingLevel } = require("docx");

const outDir = path.resolve(__dirname, "..", "test-fixtures");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

async function generatePdf() {
  return new Promise((resolve, reject) => {
    const pdfPath = path.join(outDir, "sample.pdf");
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    doc.fontSize(14).text("Monday Bot Sample PDF");
    doc.moveDown();
    doc
      .fontSize(11)
      .text(
        "This PDF is used as an ingestion fixture. It contains enough text to verify that the PDF parser can extract content and that ingestFile returns a chunk with non-empty text."
      );
    doc.end();
    stream.on("finish", () => resolve(pdfPath));
    stream.on("error", reject);
  });
}

async function generateDocx() {
  const docxPath = path.join(outDir, "sample.docx");
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: "Monday Bot Sample DOCX", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            text:
              "This DOCX is used as an ingestion fixture. It verifies that mammoth can extract raw text and that ingestFile returns a chunk with non-empty text.",
          }),
        ],
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buffer);
  return docxPath;
}

(async () => {
  const pdf = await generatePdf();
  const docx = await generateDocx();
  console.log("Generated:", pdf);
  console.log("Generated:", docx);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
