import * as path from "path";
import { parsePdf } from "../src/ingestion/parsers/pdf";

/**
 * Surface 1 (#1328) — graceful failure for unreadable PDFs.
 *
 * Real synthetic fixtures (NO mocks) so the genuine pdfjs failure path is
 * exercised: a 0-byte file and a non-PDF garbage file. The friendly wrapper must
 * name the file + a human phrase and must NOT leak raw pdfjs internals or a stack
 * frame. The PasswordException branch must stay ORDERED FIRST (covered by the
 * separate tests/pdf-password.test.ts, asserted intact below).
 */

const fixturesDir = path.resolve(__dirname, "..", "test-fixtures");
const fx = (name: string) => path.join(fixturesDir, name);

const FRIENDLY_PHRASE = "is not a readable PDF (corrupted, empty, or malformed)";
// A thrown JS stack frame looks like `\n    at <fn> (<file>:<line>:<col>)`.
const STACK_FRAME_SHAPE = /\n\s*at\s+/;

async function messageFrom(filePath: string): Promise<string> {
  try {
    await parsePdf(filePath, path.basename(filePath));
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`expected parsePdf to reject for ${filePath}`);
}

describe("parsePdf — graceful failure on unreadable PDFs (#1328 Surface 1)", () => {
  it("AC-PDF-EMPTY: a 0-byte PDF rejects with the friendly wrapper, no stack-frame leak", async () => {
    const message = await messageFrom(fx("empty.pdf"));
    expect(message).toContain(fx("empty.pdf"));
    expect(message).toContain(FRIENDLY_PHRASE);
    expect(message).not.toMatch(STACK_FRAME_SHAPE);
    // No raw pdfjs-internal class tokens leak into the user-facing message.
    expect(message).not.toMatch(/InvalidPDFException|MissingPDFException|UnknownErrorException/);
  });

  it("AC-PDF-CORRUPT: a non-PDF garbage file rejects with the same friendly wrapper", async () => {
    const message = await messageFrom(fx("corrupted.pdf"));
    expect(message).toContain(fx("corrupted.pdf"));
    expect(message).toContain(FRIENDLY_PHRASE);
    expect(message).not.toMatch(STACK_FRAME_SHAPE);
    expect(message).not.toMatch(/InvalidPDFException|MissingPDFException|UnknownErrorException/);
  });

  it("preserves the original pdfjs error out-of-band via `cause` (debuggable, not user-facing)", async () => {
    let caught: unknown;
    try {
      await parsePdf(fx("corrupted.pdf"), "corrupted.pdf");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // The raw internals are retained for debugging but kept OUT of the message.
    expect((caught as Error).cause).toBeDefined();
  });

  it("AC-PDF-PASSWORD-INTACT: the still-valid happy-path sample.pdf does NOT reject", async () => {
    // Ordering guard: a readable PDF must still parse — the generic wrapper only
    // fires on the failure path, never on a good document. (The password-branch
    // ordering itself is pinned by tests/pdf-password.test.ts.)
    const chunks = await parsePdf(fx("sample.pdf"), "sample.pdf");
    expect(chunks.length).toBeGreaterThan(0);
  });
});
