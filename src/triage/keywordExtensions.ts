/**
 * Keyword-extension loader (#1341) — the ONLY I/O ring for the runtime keyword
 * extensions. The pure matcher (`categorizeDefect`) stays I/O-free; this module
 * reads a local, GITIGNORED JSON file, validates + compiles its patterns, and
 * hands the matcher PLAIN DATA (`CategoryExtensions`) via the two shells.
 *
 * The file's real internal vocabulary must NEVER be committed to this public
 * repo — it lives at a gitignored path (`keyword-extensions*.json`) and is
 * populated by the operator locally AFTER merge. WHERE the file lives is the
 * single responsibility of the `MONDAY_KEYWORD_EXTENSIONS_FILE` env var.
 *
 * Graceful-degradation contract: an absent / empty / unreadable / malformed /
 * partially-invalid file NEVER throws to the caller — it degrades to `{}` (or a
 * partial result keeping the valid entries), so classification is IDENTICAL to
 * having no extensions at all. Only TRULY unexpected errors (not the expected
 * file-missing / parse / shape / bad-pattern cases) are allowed to surface.
 */
import * as fs from "fs";
import {
  CategoryExtensions,
  DefectCategory,
  DEFECT_CATEGORIES,
} from "./categorizeDefect";

/** Env var naming WHERE the local extensions file lives (matches the repo's `MONDAY_` prefix). */
export const KEYWORD_EXTENSIONS_ENV = "MONDAY_KEYWORD_EXTENSIONS_FILE";

/** Matchable categories = every `DefectCategory` except the rule-less `other`. */
function isMatchableCategory(key: string): key is Exclude<DefectCategory, "other"> {
  return key !== "other" && (DEFECT_CATEGORIES as readonly string[]).includes(key);
}

/** A read error we EXPECT and degrade-on (file missing / unreadable / a directory). */
function isExpectedReadError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  // ENOENT (missing), EACCES (permission), EISDIR (path is a dir), ENOTDIR — all
  // mean "the file isn't a readable JSON file here", which is a degrade case.
  return (
    code === "ENOENT" ||
    code === "EACCES" ||
    code === "EISDIR" ||
    code === "ENOTDIR"
  );
}

/**
 * Load + compile runtime keyword extensions.
 *
 * Path source: `filePath ?? process.env.MONDAY_KEYWORD_EXTENSIONS_FILE`. An empty
 * / undefined resolved path means "no extensions" → `{}` (no file read).
 *
 * File shape: `{ "<DefectCategory>": ["<regex-source>", ...], ... }`. Each pattern
 * string is compiled with `new RegExp(pattern, "i")` (case-insensitive, matching
 * the base-rule style). Every degradation mode below returns `{}` or a partial
 * result and NEVER throws:
 *   - missing / unreadable file, or path is a directory  → `{}`
 *   - empty file / invalid JSON / root is not a plain object → `{}`
 *   - a key that is not a matchable `DefectCategory` (incl. `"other"`) → skip key
 *   - a value that is not an array of strings → skip that category
 *   - a pattern that fails to compile → skip that one pattern, keep the rest
 */
export function loadKeywordExtensions(
  filePath?: string,
  log?: (msg: string) => void,
): CategoryExtensions {
  const note = (msg: string) => {
    if (log) log(`keyword-extensions: ${msg}`);
  };

  const resolved = filePath ?? process.env[KEYWORD_EXTENSIONS_ENV];
  if (!resolved || resolved.trim() === "") {
    return {};
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    if (isExpectedReadError(err)) {
      note(`file not readable at ${resolved} — using no extensions`);
      return {};
    }
    // Truly unexpected I/O failure — surface it rather than masking a real bug.
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    note("file is not valid JSON — using no extensions");
    return {};
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    note("file root is not a JSON object — using no extensions");
    return {};
  }

  const out: CategoryExtensions = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isMatchableCategory(key)) {
      note(`skipping unknown category key "${key}"`);
      continue;
    }
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      note(`skipping category "${key}" — value is not an array of strings`);
      continue;
    }

    const compiled: RegExp[] = [];
    for (const pattern of value as string[]) {
      try {
        compiled.push(new RegExp(pattern, "i"));
      } catch {
        note(`skipping invalid pattern in "${key}"`);
      }
    }
    if (compiled.length > 0) {
      out[key] = compiled;
    }
  }

  return out;
}
