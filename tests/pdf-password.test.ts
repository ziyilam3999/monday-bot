/**
 * Regression test for pdfjs PasswordException → friendly error wrapping.
 *
 * Pins the discriminator on `err.name === "PasswordException"` so a future pdfjs
 * upgrade that renames the class is caught instead of silently falling through
 * to the generic rethrow path. See PR #52 / issue #54.
 */

jest.mock("fs/promises", () => ({
  readFile: jest.fn(() => Promise.resolve(Buffer.from("dummy-pdf-bytes"))),
}));

jest.mock("pdfjs-dist/legacy/build/pdf.js", () => ({
  getDocument: jest.fn(() => ({
    promise: Promise.reject(
      Object.assign(new Error("File is encrypted"), { name: "PasswordException" }),
    ),
  })),
}));

import { parsePdf } from "../src/ingestion/parsers/pdf";

describe("parsePdf — PasswordException wrapping", () => {
  it("rethrows pdfjs PasswordException as <filePath> is password-protected", async () => {
    await expect(parsePdf("/tmp/secret.pdf", "secret.pdf")).rejects.toThrow(
      "/tmp/secret.pdf is password-protected",
    );
  });
});
