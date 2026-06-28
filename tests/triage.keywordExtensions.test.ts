import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadKeywordExtensions,
  KEYWORD_EXTENSIONS_ENV,
} from "../src/triage/keywordExtensions";
import { categorizeDefect, categorizeAll } from "../src/triage/categorizeDefect";

/**
 * Loader contract tests (#1341). All fixtures are SYNTHETIC (invented terms only:
 * `frobnicate`, `wibble`). Hermetic: no test depends on the real process env or a
 * real on-disk file — each writes its own temp file and the env-var cases
 * snapshot/clear/restore `MONDAY_KEYWORD_EXTENSIONS_FILE` so an ambient value in
 * the developer's shell cannot pollute the assertions.
 */
describe("loadKeywordExtensions — graceful loader contract", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kw-ext-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a temp file with the given contents and return its path. */
  function writeTmp(name: string, contents: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, contents, "utf8");
    return p;
  }

  it("valid file → compiled RegExp per category; feeds categorizeDefect", () => {
    const file = writeTmp(
      "keyword-extensions.json",
      JSON.stringify({ performance: ["frobnicate"], "missing-element": ["wibble"] }),
    );
    const loaded = loadKeywordExtensions(file);

    expect(loaded.performance?.length).toBe(1);
    expect(loaded.performance?.[0].test("the page will frobnicate")).toBe(true);
    expect(loaded["missing-element"]?.[0].test("the wibble is absent here")).toBe(true);

    // End-to-end: the loaded object routes a synthetic term to its category.
    expect(categorizeDefect({ summary: "the page will frobnicate" }, loaded).category).toBe(
      "performance",
    );
  });

  it("missing file → {}", () => {
    const loaded = loadKeywordExtensions(path.join(tmpDir, "does-not-exist.json"));
    expect(loaded).toEqual({});
  });

  it("path is a directory → {} (unexpected-but-handled read error)", () => {
    const loaded = loadKeywordExtensions(tmpDir);
    expect(loaded).toEqual({});
  });

  it("empty file → {}", () => {
    const file = writeTmp("empty.json", "");
    expect(loadKeywordExtensions(file)).toEqual({});
  });

  it("malformed JSON → {}", () => {
    const file = writeTmp("bad.json", "{ not json");
    expect(loadKeywordExtensions(file)).toEqual({});
  });

  it("non-object root (array) → {}", () => {
    const file = writeTmp("arr.json", JSON.stringify(["frobnicate"]));
    expect(loadKeywordExtensions(file)).toEqual({});
  });

  it("unknown category key is skipped; valid keys survive", () => {
    const file = writeTmp(
      "mixed.json",
      JSON.stringify({ "totally-not-a-category": ["x"], performance: ["frobnicate"] }),
    );
    const loaded = loadKeywordExtensions(file);
    expect(loaded).not.toHaveProperty("totally-not-a-category");
    expect(loaded.performance?.[0].test("frobnicate")).toBe(true);
  });

  it("the rule-less `other` key is rejected", () => {
    const file = writeTmp("other.json", JSON.stringify({ other: ["x"] }));
    expect(loadKeywordExtensions(file)).toEqual({});
  });

  it("non-array value for a category is skipped", () => {
    const file = writeTmp(
      "nonarr.json",
      JSON.stringify({ performance: "frobnicate", "missing-element": ["wibble"] }),
    );
    const loaded = loadKeywordExtensions(file);
    expect(loaded).not.toHaveProperty("performance");
    expect(loaded["missing-element"]?.[0].test("wibble")).toBe(true);
  });

  it("bad pattern is skipped; the rest of the category survives", () => {
    const file = writeTmp("badpat.json", JSON.stringify({ performance: ["(", "frobnicate"] }));
    const loaded = loadKeywordExtensions(file);
    expect(loaded.performance?.length).toBe(1);
    expect(loaded.performance?.[0].test("frobnicate")).toBe(true);
  });

  describe("env-var path source (hermetic snapshot/restore)", () => {
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[KEYWORD_EXTENSIONS_ENV];
      delete process.env[KEYWORD_EXTENSIONS_ENV];
    });

    afterEach(() => {
      if (saved === undefined) delete process.env[KEYWORD_EXTENSIONS_ENV];
      else process.env[KEYWORD_EXTENSIONS_ENV] = saved;
    });

    it("absent env var (no arg) → {}", () => {
      expect(loadKeywordExtensions(undefined)).toEqual({});
    });

    it("env var pointing at a valid file is honored", () => {
      const file = writeTmp("via-env.json", JSON.stringify({ performance: ["frobnicate"] }));
      process.env[KEYWORD_EXTENSIONS_ENV] = file;
      const loaded = loadKeywordExtensions();
      expect(loaded.performance?.[0].test("frobnicate")).toBe(true);
    });
  });

  it("identical-behavior proof: missing extensions ⇒ counts unchanged", () => {
    const inputs = [
      { summary: "the application crashed unexpectedly" },
      { summary: "the running total shows the wrong amount" },
      { summary: "general miscellaneous note" },
    ];
    const base = categorizeAll(inputs);
    const withMissing = categorizeAll(inputs, loadKeywordExtensions("/nonexistent/path.json"));
    expect(withMissing.counts).toEqual(base.counts);
  });
});
