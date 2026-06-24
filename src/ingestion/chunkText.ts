/**
 * Passage chunking for retrieval (#1189).
 *
 * WHY: Confluence pages are embedded for vector search. Embedding a whole long
 * page as ONE averaged vector dilutes the relevant sentence into the page mean,
 * so a 13.5K-char how-to page scores far below short keyword-dense docs and
 * never lands in top-K. (Two compounding effects: averaging-dilution AND silent
 * truncation — the MiniLM embedder TRUNCATES input past its 512-token window
 * rather than throwing, so a whole-page vector literally never "sees" anything
 * past ~the first ~512 tokens / ~2000 chars.) Splitting a page into bounded
 * passages and embedding each as its own vector fixes both: the relevant passage
 * embeds undiluted and untruncated, and ranks high.
 *
 * `stripHtml` (confluence/sync.ts) collapses ALL whitespace to single spaces, so
 * the page body arrives as one long line with NO paragraph breaks. This splitter
 * is therefore SENTENCE/window-based, not blank-line-based.
 *
 * Pure, deterministic, no I/O.
 */

export interface SplitOptions {
  /**
   * Soft upper bound on passage length in characters. Default 900 (~225 tokens
   * — comfortably under MiniLM's 512-token window, so each passage embeds
   * without truncation). A passage never exceeds this EXCEPT an unavoidable
   * single sentence longer than `maxChars`, which is itself hard-window-split
   * into pieces each `<= maxChars`.
   */
  maxChars?: number;
  /**
   * Characters of trailing context carried from the end of one passage into the
   * start of the next, for continuity across the cut. Default 150. Only applied
   * when it still fits within `maxChars` alongside the next sentence.
   */
  overlapChars?: number;
  /**
   * Drop passages shorter than this — but ONLY as a cleanup of EXTRA tail/interior
   * fragments when there are >= 2 passages. A non-empty body ALWAYS yields >= 1
   * passage; minChars never zeroes out the sole passage (correction #1, #1189).
   * Default 20.
   */
  minChars?: number;
}

const DEFAULT_MAX_CHARS = 900;
const DEFAULT_OVERLAP_CHARS = 150;
const DEFAULT_MIN_CHARS = 20;

/**
 * Take up to `overlapChars` characters from the END of `text`, aligned to a word
 * boundary (so we don't carry a half-word). Returns "" when overlap is disabled
 * or `text` is empty.
 */
function overlapTail(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length === 0) return "";
  if (text.length <= overlapChars) return text.trim();
  let tail = text.slice(text.length - overlapChars);
  // Drop the leading partial word (everything up to and including the first space).
  const firstSpace = tail.indexOf(" ");
  if (firstSpace >= 0) tail = tail.slice(firstSpace + 1);
  return tail.trim();
}

/**
 * Hard char-window split for a single sentence that alone exceeds `maxChars`
 * (no sentence boundary to pack against — e.g. a code block or a run-on with no
 * `. ! ?`). Windows step by `maxChars - overlapChars` so consecutive windows
 * overlap; each window is `<= maxChars`.
 */
function hardWindowSplit(sentence: string, maxChars: number, overlapChars: number): string[] {
  const out: string[] = [];
  const step = Math.max(1, maxChars - Math.max(0, overlapChars));
  for (let start = 0; start < sentence.length; start += step) {
    const piece = sentence.slice(start, start + maxChars).trim();
    if (piece.length > 0) out.push(piece);
    if (start + maxChars >= sentence.length) break;
  }
  return out;
}

/**
 * Split `text` into overlapping passages, each `<= maxChars` (modulo a single
 * over-long sentence, which is hard-window-split). Sentence-aware: greedily packs
 * whole sentences until the next would overflow, then emits and starts a fresh
 * passage carrying an `overlapChars` tail for continuity.
 *
 * Guarantees:
 *  - empty / whitespace-only input -> `[]`
 *  - any non-empty trimmed input -> >= 1 passage (minChars NEVER drops the sole
 *    passage — correction #1, #1189)
 *  - deterministic; no I/O
 *
 * Overlap is dedup-safe at the index layer: VectorIndex auto-ids each chunk by
 * sha1(source + text), so distinct passage texts get distinct ids; two
 * byte-identical passages (a degenerate repeated-sentence doc) collide on id and
 * VectorIndex.add already skips-with-warn (it does NOT throw) — they collapse to
 * one chunk. No custom dedup is needed here (correction #4, #1189).
 */
export function splitIntoPassages(text: string, opts: SplitOptions = {}): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;

  if (typeof text !== "string") return [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  // The body is single-spaced collapsed text; sentence-split on terminal
  // punctuation followed by whitespace. (stripHtml keeps . ! ? — see module doc.)
  const sentences = trimmed.split(/(?<=[.!?])\s+/);

  const passages: string[] = [];
  let current = "";

  const flush = (): void => {
    const t = current.trim();
    if (t.length > 0) passages.push(t);
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;

    // A single sentence longer than maxChars can't be packed — emit what we have,
    // then hard-window-split the over-long sentence on its own.
    if (sentence.length > maxChars) {
      flush();
      current = "";
      for (const piece of hardWindowSplit(sentence, maxChars, overlapChars)) {
        passages.push(piece);
      }
      continue;
    }

    const candidate = current.length === 0 ? sentence : `${current} ${sentence}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    // Adding this sentence would overflow: emit current, start fresh. Carry an
    // overlap tail only if it still leaves the new passage within maxChars.
    flush();
    const tail = overlapTail(current, overlapChars);
    if (tail.length > 0 && tail.length + 1 + sentence.length <= maxChars) {
      current = `${tail} ${sentence}`;
    } else {
      current = sentence;
    }
  }
  flush();

  // minChars cleanup: only drop short EXTRA fragments, and only when >= 2
  // passages exist — never zero out a non-empty body (correction #1).
  let result = passages;
  if (result.length >= 2) {
    const filtered = result.filter((p) => p.length >= minChars);
    if (filtered.length > 0) result = filtered;
  }

  // Belt-and-suspenders: a non-empty trimmed body must ALWAYS yield >= 1 passage.
  if (result.length === 0) result = [trimmed];

  return result;
}
