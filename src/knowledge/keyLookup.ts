/**
 * #3299 — exact issue-key extraction, the cheap guard in front of the vector
 * pipeline. The bot today answers only by meaning (bi-encoder top-12), so a
 * question that NAMES a ticket ("Can you extract Jira Demo 673?") is answered by
 * the ticket's look-alike neighbours instead. This module pulls the named key
 * out of the question so `KnowledgeService.query` can pin that issue's chunks
 * first (or live-fetch exactly that issue when it is unindexed).
 *
 * Shapes (see the plan's intent item 1). For EVERY configured project key,
 * matched as a standalone token, case-insensitively, never glued to other
 * letters or digits:
 *
 *   1. HYPHENATED `DEMO-673` (any case) — fires UNCONDITIONALLY. A hyphen
 *      directly joining a configured project key to digits is unambiguous.
 *   2. SPACED `DEMO 673` / `Demo 673`, or FUSED `demo673` (any case) — fires ONLY
 *      when a Jira-context word (jira/ticket/issue/key, any case) appears among
 *      the 3 tokens immediately BEFORE the project-key token. The context word
 *      must PRECEDE the key: English prose puts its nouns after the number
 *      ("demo 3 tickets"), so a context word that only follows never fires.
 *
 * The context guard is paid for by separator tolerance: the fixture project key
 * `DEMO` is itself an English word, so without the guard "Can I demo 2 volunteers
 * to review the doc?" would pin DEMO-2 and replace the real answer (plan-review
 * r1 finding 1). The guard applies uniformly to the loose shapes for EVERY
 * configured key — no dictionary, conservative direction: a missed loose form
 * falls back to today's vector behavior.
 *
 * A bare number never becomes a key; a key whose project is not configured is
 * not extracted; the number must be a standalone digit run (never part of a
 * longer number like 673.5, never carrying letters like 673a). The canonical
 * key uses the configured list's OWN casing, so the emitted key matches the
 * `jira:<KEY>` source ids the sync writes even when the question's casing
 * differs. Keys are returned DISTINCT, in first-mention order; the caller caps
 * how many are resolved (#3299: at most 3).
 *
 * Pure + deterministic — no I/O, no model.
 */

/**
 * Words that make a loose (spaced/fused) key mention unambiguous. Any case.
 * NOTE (named risk 3299-word-context-guard, plan-review r2): `key`, `issue`,
 * `ticket` are ordinary English, so "the key is to demo 3 volunteers on this"
 * DOES satisfy the guard as specified — the plan's uniform rule fires there.
 * This is the registered trade-off for not shipping a prose dictionary; the
 * plan-review registered the risk rather than growing the guard arms.
 */
export const JIRA_CONTEXT_WORDS: ReadonlySet<string> = new Set([
  "jira",
  "ticket",
  "issue",
  "key",
]);

/** How many tokens before the key token are searched for a context word. */
export const JIRA_CONTEXT_WINDOW = 3;

type TokenKind = "word" | "num" | "other";

interface Token {
  text: string;
  kind: TokenKind;
  /** Index of the token's first character in the original question. */
  start: number;
  /** Index one past the token's last character. */
  end: number;
}

function charKind(ch: string): TokenKind | undefined {
  if (/[A-Za-z]/.test(ch)) return "word";
  if (/[0-9]/.test(ch)) return "num";
  return undefined;
}

/**
 * Split into maximal runs: `[A-Za-z]+` → word, `[0-9]+` → num, every other
 * character a single `other` token. Token boundaries carry the gluing
 * information the shapes need: `demon-673` is word("demon") ≠ "demo";
 * `demo673` is word("demo") immediately followed by num("673"); `673a` is
 * num("673") immediately followed by word("a").
 */
function tokenize(question: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  while (i < question.length) {
    const kind = charKind(question[i]);
    if (kind === undefined) {
      toks.push({ text: question[i], kind: "other", start: i, end: i + 1 });
      i++;
      continue;
    }
    let j = i + 1;
    while (j < question.length && charKind(question[j]) === kind) j++;
    toks.push({ text: question.slice(i, j), kind, start: i, end: j });
    i = j;
  }
  return toks;
}

/** True when `b` starts exactly where `a` ends (no gap between the tokens). */
function adjacent(a: Token, b: Token): boolean {
  return a.end === b.start;
}

/**
 * True when the number token at `j` is a STANDALONE digit run: nothing glued
 * after it carries letters or continues the number. "673a", "673.5", "673's"
 * fail; "673?", "673.", "673)" pass (trailing punctuation is fine — only a
 * glued continuation disqualifies).
 */
function numberIsCleanAfter(toks: Token[], j: number): boolean {
  let prev = toks[j];
  for (let k = j + 1; k < toks.length && adjacent(prev, toks[k]); k++) {
    const t = toks[k];
    if (t.kind === "word" || t.kind === "num") return false; // glued letters/digits
    if (/\s/.test(t.text)) return true; // a space ends the glued chain — clean
    prev = t; // punctuation glued to the number — keep walking the chain
  }
  return true;
}

/**
 * A Jira-context word among the JIRA_CONTEXT_WINDOW word/num tokens immediately
 * before the key token (punctuation tokens are skipped, not counted).
 */
function hasContextWordBefore(toks: Token[], keyIdx: number): boolean {
  let seen = 0;
  for (let i = keyIdx - 1; i >= 0 && seen < JIRA_CONTEXT_WINDOW; i--) {
    const t = toks[i];
    if (t.kind === "other") continue;
    seen++;
    if (t.kind === "word" && JIRA_CONTEXT_WORDS.has(t.text.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * #3378 — field-question phrase directly before the key token. Words that name
 * a Jira field a user asks about. Any case.
 */
export const JIRA_FIELD_WORDS: ReadonlySet<string> = new Set([
  "status",
  "assignee",
  "priority",
]);

/** Prepositions that may join a field word to the key ("status OF get 673"). */
const FIELD_PREPOSITIONS: ReadonlySet<string> = new Set(["of", "for", "on"]);

/**
 * True when the key token at `keyIdx` is directly preceded by
 * `<field> <of|for|on>` with ONLY whitespace between the three. Punctuation
 * anywhere in the phrase ("status, of get 2", "priority: get 3") blocks it, and
 * a field word elsewhere in the sentence does not count. Narrow by design: the
 * project key can be an everyday verb ("get"), so a loose field word would
 * false-fire on prose like "our priority is to get 2 hotfixes out".
 */
function hasFieldPhraseBefore(toks: Token[], keyIdx: number): boolean {
  let i = keyIdx - 1;
  const skipWs = () => {
    while (i >= 0 && toks[i].kind === "other" && /^\s$/.test(toks[i].text)) i--;
  };
  skipWs();
  const prep = toks[i];
  if (!prep || prep.kind !== "word" || !FIELD_PREPOSITIONS.has(prep.text.toLowerCase())) {
    return false;
  }
  i--;
  skipWs();
  const field = toks[i];
  return !!field && field.kind === "word" && JIRA_FIELD_WORDS.has(field.text.toLowerCase());
}

interface NumberMatch {
  digits: string;
  shape: "hyphen" | "spaced" | "fused";
}

/**
 * Match the number that makes this key token a key mention, if any. The key
 * token must not be glued to letters/digits on its LEFT; the number must be a
 * standalone digit run on its RIGHT; the separator decides the shape.
 */
function matchKeyNumber(
  toks: Token[],
  keyIdx: number,
  question: string,
): NumberMatch | null {
  const key = toks[keyIdx];
  const prev = toks[keyIdx - 1];
  if (prev && adjacent(prev, key) && prev.kind !== "other") return null; // xDEMO / 3DEMO

  // First non-whitespace token after the key (whitespace tokens are `other`
  // singles; skipping them is what makes "DEMO 673" a SPACED shape while
  // "DEMO-673" / "demo673" stay directly adjacent).
  let nextIdx = keyIdx + 1;
  while (nextIdx < toks.length && toks[nextIdx].kind === "other" && /\s/.test(toks[nextIdx].text)) {
    nextIdx++;
  }
  const next = toks[nextIdx];
  if (!next) return null;

  // Hyphenated: a `-` directly joining the key to a standalone digit run. This
  // is the unambiguous shape — no context word required.
  if (next.kind === "other" && next.text === "-" && adjacent(key, next)) {
    const num = toks[nextIdx + 1];
    if (num && num.kind === "num" && adjacent(next, num) && numberIsCleanAfter(toks, keyIdx + 2)) {
      return { digits: num.text, shape: "hyphen" };
    }
    return null;
  }

  if (next.kind !== "num") return null;

  if (adjacent(key, next)) {
    return numberIsCleanAfter(toks, nextIdx)
      ? { digits: next.text, shape: "fused" }
      : null;
  }
  const gap = question.slice(key.end, next.start);
  if (!/^\s+$/.test(gap)) return null; // "DEMO, 673" / "DEMO- 673" / "DEMO/673" — not a key shape
  return numberIsCleanAfter(toks, nextIdx)
    ? { digits: next.text, shape: "spaced" }
    : null;
}

/**
 * Extract every issue key named in `question` for the CONFIGURED project keys.
 * Returns distinct canonical keys (`<CONFIGURED-CASING>-<number>`), first-mention
 * order, UNCAPPED — the caller applies the resolve cap (#3299: 3).
 */
export function extractIssueKeys(
  question: string,
  projectKeys: readonly string[],
): string[] {
  if (typeof question !== "string" || question.length === 0) return [];
  if (!Array.isArray(projectKeys) || projectKeys.length === 0) return [];

  // lowercase question prefix -> configured casing (first entry wins on dupes)
  const canonical = new Map<string, string>();
  for (const p of projectKeys) {
    if (typeof p !== "string" || p.length === 0) continue;
    const lower = p.toLowerCase();
    if (!canonical.has(lower)) canonical.set(lower, p);
  }
  if (canonical.size === 0) return [];

  const toks = tokenize(question);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "word") continue;
    const configured = canonical.get(t.text.toLowerCase());
    if (!configured) continue;
    const m = matchKeyNumber(toks, i, question);
    if (!m) continue;
    // Loose shapes need a Jira-context word BEFORE the key; hyphenated is
    // unambiguous and fires unconditionally.
    if (
      m.shape !== "hyphen" &&
      !hasContextWordBefore(toks, i) &&
      !hasFieldPhraseBefore(toks, i)
    ) {
      continue;
    }
    // Normalize leading zeros only (DEMO-0673 -> DEMO-673); never through
    // Number(), which would go scientific on very long digit runs.
    const digits = m.digits.replace(/^0+(?=\d)/, "");
    const key = `${configured}-${digits}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
