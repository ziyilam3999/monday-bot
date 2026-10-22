import { getClient, warnMaxTokensStop } from "./anthropicClient";
import { resolveModel } from "./modelConfig";
// #3323 — the bot's own name vocabulary is borrowed from the ONE list the
// Telegram greeting gate already ships (B2: matcher data is borrowed, never
// copied; helpGate.ts itself is untouched). Pure constants, no I/O.
import { BOT_NAME_TOKENS, GREETING_LEXICON } from "../telegram/helpGate";

const MODEL = resolveModel();
// #3136 fix 1: Haiku 5.5's DEFAULT (unset-effort) thinking budget spends tokens
// BEFORE the text block, so the old 1024 cap truncated real-size how-to replies
// (review probe: 2/3 runs stopped at max_tokens). 8192 = 4x the classifier's
// medium-effort 2048 cap - ample for default thinking plus the 50-400-word
// answer target, and at $0.50/MTok output the worst case is $0.004 per reply.
const MAX_TOKENS = 8192;

export const SYSTEM_PROMPT =
  "You answer factually from the provided context only. " +
  "Lead with what you DID find in the context and cite it with inline [N] citations that map to the numbered sources in the context block; " +
  "only after stating what you found, note any remaining gap. " +
  "CRITICAL: whenever the context contains ANY material RELEVANT to the question, your answer MUST OPEN with what IS covered (and cite it [N]); state what is missing ONLY AFTER that. " +
  "You must NOT open with \"I couldn't find...\" whenever the context holds relevant material — that opener is RESERVED ONLY for the case where the context is genuinely off-topic and contains NO relevant information at all. " +
  "GOOD (relevant context): \"The Initial Setup doc [1] covers Flutter, Riverpod, themes, and API setup; there isn't a separate step-by-step local-env guide in the docs.\" " +
  "BAD (relevant context, wrong opener): \"I couldn't find specific instructions... but the context includes a checklist [1].\" " +
  "ABSTAIN (off-topic context, no relevant material): say you couldn't find any relevant information, with no citations. " +
  "PROCESS/SPEC DOCS COUNT AS GROUNDING: when the context contains a doc passage that describes the relevant PROCESS, MECHANISM, business rules, or spec for what is asked — even if it is NOT a step-by-step click-by-click user tutorial — treat it as grounding material: lead with what the documented process IS and cite it [N], then (only after) note that this is the documented process rather than a tap-by-tap UI walkthrough. " +
  "Passages framed as BUSINESS RULES, specs, change-logs, internal-reference notes, or backend/engineering tickets STILL count as grounding when they describe the STEPS, FLOW, or MECHANISM of what the user asked about. Do NOT refuse merely because the material is framed as internal/backend/business-rules rather than a polished end-user guide — translate the documented flow into plain user-facing steps and cite [N]. For example, if the question is how to find/do something and a passage describes the matching/selection/decision flow for exactly that, EXPLAIN that flow as the answer instead of saying there are no user-facing instructions. " +
  "This process/spec clause applies ONLY when that passage is genuinely ON-TOPIC and relevant to the exact question asked; a process or spec passage that is about a DIFFERENT topic than the question is NOT grounding for that question — do not cite it, and abstain if nothing on-topic remains. " +
  "SINGLE-PRODUCT KNOWLEDGE BASE: every passage here is about ONE product, so the ABSENCE of the product's or a feature's NAME (a brand or proper-noun) from the passages is MEANINGLESS — a missing brand word does NOT mean the topic is uncovered, and you must NEVER open with \"I couldn't find\" merely because the exact product or feature name from the question is not present verbatim in the passages. Decide grounding ONLY on whether the passages genuinely DESCRIBE THE TOPIC OR FEATURE the question asks about: if any passage describes that topic's mechanism, flow, rules, locations, or plans — even partially, even as a roadmap or backend/spec note — you MUST lead with that documented answer and cite [N], not prepend a hedge, even though the passage never names the product. The ONLY exception is the no-yes-man clamp: a passage that merely mentions or is generally about the product but does NOT address the specific topic asked is NOT grounding — only in that case do you cleanly decline with no citations. This clause removes ONLY proper-noun ABSENCE as a disqualifier; the existing genuinely ON-TOPIC precondition above still governs — it does NOT relax the requirement that the passage be on-topic to the exact question asked. " +
  "TOPIC-COVERED vs TOPIC-ABSENT: decide whether to answer on the QUESTION'S TOPIC, never on whether a product or feature NAME string is present verbatim in the passages. GOOD (topic covered, name absent): the question names a product or feature whose NAME does NOT appear in the passages, but a passage describes that topic's mechanism, flow, rules, locations, or plans — you MUST lead with that documented answer and cite [N]; do NOT open with a refusal merely because the name is missing. BAD (topic covered, wrong opener): opening with \"I couldn't find ...\" just because the named thing is not written verbatim, while a passage describes the asked topic. ABSTAIN only when the TOPIC ITSELF is genuinely absent or off-topic — then decline cleanly with no citations. " +
  "HOW-TO SYNTHESIS: when the question is phrased as how to / how do I / where do I do or find something, and a passage describes that topic's flow, mechanism, rules, or decision/matching logic — even when framed as a backend/internal/engineering spec rather than a polished tap-by-tap UI tutorial — you MUST translate that documented flow into plain user-facing steps and cite [N]. GOOD (how-to, spec-framed): leading with the synthesized steps drawn from the documented flow [N], noting only afterward that this is the documented process rather than a tap-by-tap walkthrough. BAD (how-to, spec-framed): declining with \"these describe backend/internal specs, not user-facing steps\" (or equivalent) while a passage DOES describe the asked flow. This clause removes ONLY \"framed as internal spec / not a step-by-step tutorial\" as a disqualifier; it does NOT relax the on-topic gate — abstain cleanly with no citations when the topic itself is genuinely absent or off-topic. " +
  "When you abstain, your reply MUST contain NO [N] citation markers at all — never cite a loosely-related passage while saying you couldn't find the answer. " +
  "PREFER DOCS OVER TICKET STUBS: when both narrative/document sources and bare issue-tracker ticket stubs cover the same topic, build your answer from and cite the document/narrative passages, not bare ticket titles. " +
  "PHASED / PLANNED ROLLOUTS: when the relevant doc describes a PLANNED or PHASED rollout or roadmap, answer with what is LIVE now and what is NAMED-planned and cite the doc [N]; do NOT dismiss a roadmap as \"no comprehensive list.\" " +
  "Never cite outside the numbered list. " +
  "If the context contains no relevant information, say you couldn't find the information (a clean refusal with no citations). " +
  "Keep answers concise (target 50-400 words) and suitable for a Slack message. " +
  // #3323 — identity/vocative clause (B4). Scoped to INTERPRETATION, not
  // persona: it tells the model how to read the name, never how to sign or
  // address users. (1) name the assistant, (2) define name-call positions as
  // vocatives, (3) preserve weekday-as-date readings elsewhere.
  "YOU ARE MONDAY BOT: this team's knowledge assistant, and users address you by name as \"Monday\" or \"monday-bot\". " +
  "When the question contains that name in CALL POSITION — leading (\"Monday, …\"), right after a greeting (\"hey Monday …\"), trailing (\"…, Monday?\"), or an @-mention — it is a VOCATIVE: the user talking TO you. " +
  "A vocative name is NEVER a date, a deadline, or part of the question's content — do not answer about the weekday and do not treat it as something the user is waiting for. " +
  "Elsewhere in the question, a weekday word used as an actual date (\"what was deployed on Monday\") KEEPS its date meaning.";

export const NO_CONTEXT_ANSWER =
  "I couldn't find any relevant information in the indexed documents to answer this question.";
/**
 * #3323 — the bot knows its own name. A name in CALL POSITION ("Monday, …")
 * used to reach the model as question content and get read as the weekday.
 * This pure, total cleaner removes exactly those name-call tokens before the
 * `Question:` line is built; every non-match returns the input BYTE-IDENTICAL
 * (the #3299 parity convention applied at this seam). Arms (B3, conservative:
 * ambiguity → keep), independent and composable:
 *
 *   leading          first token is a name AND comma-announced AND the next
 *                    word is not the start of a date phrase → drop both
 *   greeting-adjacent true salutation then a name → drop the name, keep greeting
 *   trailing         last token is a name AND the previous token ends in a
 *                    comma AND is not itself a weekday → drop name and comma
 *   @-mention        any "@name" token whose folded remainder is a name → drop
 *
 * The name vocabulary IS `BOT_NAME_TOKENS` from the Telegram greeting gate —
 * imported, never duplicated (B2), so a token added there is covered here with
 * no edit. Matching normalization (case-fold, trailing-punctuation strip,
 * "_"→"-" fold for mention usernames) is INTERNAL to this function.
 *
 * Fix cycle 1 (execution review #3323): a comma alone does not mark a vocative
 * when the neighbouring words continue a DATE — "Monday, Tuesday and
 * Wednesday", "Monday, May 5th", "morning Monday standup" all keep their
 * weekday. And a fired arm removes only its own tokens plus the whitespace
 * that announced them; every other newline and space run survives verbatim.
 */

/** Telegram's own hard message cap — past it the cleaner declines entirely
 * (fails closed: input returned byte-identical, no tokenization loop). */
const MAX_CLEANABLE_LENGTH = 4096;

/** Weekday names: a name token followed by another weekday opens a day LIST
 * ("Monday, Tuesday and Wednesday: who is on call?"), not a vocative. */
const WEEKDAY_WORDS: ReadonlySet<string> = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

/** Month names: "Monday, May 5th" is a date phrase, not a vocative. */
const MONTH_WORDS: ReadonlySet<string> = new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]);

/** Ordinal words: "Monday, third of May" is a date phrase, not a vocative. */
const ORDINAL_WORDS: ReadonlySet<string> = new Set([
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
]);

/** GREETING_LEXICON words that double as times of day. At this seam they are
 * NOT salutations: "morning Monday standup?" is a date phrase, so they never
 * arm the greeting-adjacent cleaner (helpGate's own card gate is untouched
 * and keeps the full lexicon). */
const TIME_OF_DAY_WORDS: ReadonlySet<string> = new Set([
  "good",
  "morning",
  "afternoon",
  "evening",
]);

/** The greeting-adjacent arm's salutations: GREETING_LEXICON borrowed from
 * the help gate (B2, no second list) minus the time-of-day words above. */
const SALUTATIONS: ReadonlySet<string> = new Set(
  [...GREETING_LEXICON].filter((w) => !TIME_OF_DAY_WORDS.has(w)),
);

/** Split one raw token into its word, its trailing punctuation, and whether
 * that punctuation included a comma (the announcing-comma signal). */
function splitTrailingPunctuation(raw: string): {
  word: string;
  tail: string;
  hadComma: boolean;
} {
  let end = raw.length;
  let hadComma = false;
  while (end > 0 && /[!?.,…]/.test(raw[end - 1])) {
    if (raw[end - 1] === ",") hadComma = true;
    end -= 1;
  }
  return { word: raw.slice(0, end), tail: raw.slice(end), hadComma };
}

/** Separator-folded, case-folded comparison form ("@monday_bot," → the token
 * "monday-bot" as it lives in BOT_NAME_TOKENS). */
function nameComparisonForm(raw: string): string {
  return splitTrailingPunctuation(raw).word.toLowerCase().replace(/_/g, "-");
}

/** Is this raw token one of the bot's own names (ignoring case, trailing
 * punctuation, and the "_"-vs"-" username separator)? */
function isNameToken(raw: string): boolean {
  return BOT_NAME_TOKENS.includes(nameComparisonForm(raw));
}

/** Does this raw token READ as the start of a date phrase (weekday, month,
 * ordinal, number, or "the") rather than the body of a question addressed to
 * the bot? Fix cycle 1: such a word after "Monday," means the weekday is a
 * date, not a name-call. */
function isDatePhraseWord(raw: string): boolean {
  const word = nameComparisonForm(raw);
  return (
    WEEKDAY_WORDS.has(word) ||
    MONTH_WORDS.has(word) ||
    ORDINAL_WORDS.has(word) ||
    word === "the" ||
    /^\d/.test(word)
  );
}

export function stripNameCall(question: string): string {
  if (question.length > MAX_CLEANABLE_LENGTH) return question; // fail closed

  // Tokens with their spans in the ORIGINAL string, so a fired arm removes
  // only its own tokens and the whitespace that announced them.
  const rawTokens: string[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  const tokenRe = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(question)) !== null) {
    rawTokens.push(match[0]);
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  if (rawTokens.length === 0) return question;

  const remove = new Set<number>();
  const n = rawTokens.length;

  // Leading arm: comma-gated on purpose — "Monday what was deployed" (no
  // comma) is genuinely ambiguous between vocative and date-subject, and the
  // doctrine keeps it (the prompt clause is the guard there). Fix cycle 1:
  // even comma-announced, the arm must NOT fire when the next word continues
  // a date ("Monday, Tuesday …", "Monday, May 5th", "Monday, the 3rd").
  if (isNameToken(rawTokens[0])) {
    const first = splitTrailingPunctuation(rawTokens[0]);
    if (first.hadComma || rawTokens[1] === ",") {
      const bodyIndex = first.hadComma ? 1 : 2; // skip a standalone comma token
      if (!(rawTokens[bodyIndex] !== undefined && isDatePhraseWord(rawTokens[bodyIndex]))) {
        remove.add(0);
        if (!first.hadComma) remove.add(1); // the standalone comma token
      }
    }
  }

  // Greeting-adjacent arm: "hey Monday, …" — the greeting itself is today's
  // noise and is never misread as a date; only the name-call goes. Fix cycle
  // 1: only TRUE salutations arm this ("morning Monday standup?" keeps its
  // weekday), via SALUTATIONS (GREETING_LEXICON minus time-of-day words).
  if (
    remove.size === 0 &&
    rawTokens.length > 1 &&
    SALUTATIONS.has(nameComparisonForm(rawTokens[0])) &&
    isNameToken(rawTokens[1])
  ) {
    remove.add(1);
    // Keep the comma that announced the name, parked on the greeting word
    // ("hey Monday, can…" → "hey, can…"), unless it already ends punctuated.
    const second = splitTrailingPunctuation(rawTokens[1]);
    if (second.hadComma && !/[!?.,…]$/.test(rawTokens[0])) {
      rawTokens[0] += ",";
    }
  }

  // Trailing arm: the announcing comma is what separates "can you help,
  // Monday?" from "what was deployed on Monday?" — without it, never fire.
  // Fix cycle 1: a weekday before the comma announces a day LIST ("Tuesday,
  // Monday?"), not a name-call, so it guards this arm too.
  if (
    rawTokens.length > 1 &&
    isNameToken(rawTokens[n - 1]) &&
    splitTrailingPunctuation(rawTokens[n - 2]).hadComma &&
    !WEEKDAY_WORDS.has(nameComparisonForm(rawTokens[n - 2]))
  ) {
    remove.add(n - 1);
    // The comma that announced the name goes with it.
    rawTokens[n - 2] = rawTokens[n - 2].replace(/,+$/, "");
  }

  // @-mention arm: position-free but name-matched — a mention of THE bot is a
  // call to the bot, never question content; mentions of anyone else stay.
  for (let i = 0; i < n; i += 1) {
    if (rawTokens[i].startsWith("@") && BOT_NAME_TOKENS.includes(nameComparisonForm(rawTokens[i].slice(1)))) {
      remove.add(i);
    }
  }

  if (remove.size === 0) return question; // byte-identical default path (B3)

  // Nothing but a name-call: hand the question through untouched rather than
  // feeding the model an empty question.
  if (remove.size >= n) return question;

  // Rebuild from the original string (fix cycle 1: whitespace survives). A
  // kept token keeps the exact whitespace run that preceded it in the input;
  // the gap in front of a token whose predecessor was removed collapses to
  // one space, and the first kept token starts the output (no leading gap).
  let out = "";
  for (let i = 0; i < n; i += 1) {
    if (remove.has(i)) continue;
    if (out.length > 0) {
      out += remove.has(i - 1) ? " " : question.slice(spans[i - 1].end, spans[i].start);
    }
    out += rawTokens[i];
  }
  return out;
}

/**
 * #1374b — refusal-opener backstop.
 *
 * Default phrase set the model tends to OPEN a refusal with. Configurable via
 * `MONDAY_REFUSAL_OPENERS` (comma-separated; trimmed; empties dropped — mirrors
 * `parseDefaultProjects` in `src/config/env.ts`). Per the no-magic-string rule:
 * the phrase set is data, not an inline literal buried in the detector.
 */
const DEFAULT_REFUSAL_OPENERS = [
  "I couldn't find",
  "I could not find",
  "I'm unable to find",
  "I am unable to find",
  "I don't have",
  "I do not have",
  "There is no relevant",
  "No relevant information",
];

/**
 * Firmer, CONDITIONAL retry directive appended on the bad path. It must NOT
 * order the model to "answer anyway" — there is no relevance threshold upstream
 * (`service.ts` passes whatever retrieval returns), so the genuine-abstain
 * escape is preserved verbatim. The retry only corrects a proper-noun-absence
 * over-refusal; it never manufactures an answer from off-topic chunks.
 */
const REGEN_DIRECTIVE =
  "Re-examine the passages above. IF any passage describes the TOPIC of the question — its mechanism, flow, rules, locations, or plans — even though the product/feature NAME may be absent, then lead with that documented answer and cite it [N], and note any gap only afterward. IF the passages genuinely do NOT address the asked topic, abstain plainly with no citations. Never state facts that are not in the passages.";

/**
 * #1380 — how-to over-refusal backstop (SECOND refusal class).
 *
 * The #1374 backstop catches the START-ANCHORED not-found opener. This class is
 * the BODY-POSITION how-to hedge: the model leads with content, then declines in
 * the body ("…these are backend/internal specs, not user-facing steps"). That is
 * NOT start-anchored, so `opensWithRefusal` misses it.
 *
 * Default phrase set the model tends to hedge with (generic + name-free).
 * Configurable via `MONDAY_HOWTO_HEDGE_PHRASES` (comma-separated; trimmed;
 * empties dropped; a non-empty parse REPLACES the defaults — identical semantics
 * to `refusalOpeners()`). Per the no-magic-string rule: data, not inline literals.
 */
const DEFAULT_HOWTO_HEDGE_PHRASES = [
  "not user-facing steps",
  "not user-facing instructions",
  "backend/internal specs",
  "internal spec",
  "no step-by-step",
  "not a step-by-step",
  "don't include step-by-step",
  "no user-facing",
];

/**
 * #1380 — coverage-floor default. DERIVED from the Step-0 retrieval probe on the
 * real corpus (NOT a guess): the on-topic symptom passage scored cosine 0.5679
 * in final topK, while a genuinely off-topic control query's best chunk scored
 * 0.1989. 0.35 sits comfortably between them (margin 0.15 above the off-topic
 * control, 0.22 below the on-topic passage) — it separates "retrieved genuinely
 * on-topic material" from "retrieved nothing relevant," it does NOT re-rank.
 * Override via `MONDAY_HOWTO_COVERAGE_MIN_SCORE`.
 */
const DEFAULT_HOWTO_COVERAGE_MIN_SCORE = 0.35;

/**
 * Firmer, CONDITIONAL retry directive for the how-to hedge class. Like
 * `REGEN_DIRECTIVE` it must NOT order the model to "answer anyway": if the
 * passages genuinely do not address the topic it abstains plainly. It only
 * corrects the "framed as an internal spec, so I can't give steps" brush-off.
 */
const HOWTO_REGEN_DIRECTIVE =
  "Re-examine the passages. IF any passage describes how the asked thing works — its flow, mechanism, rules, or decision/matching logic — even if it reads as an internal/engineering spec rather than a tap-by-tap tutorial, then SYNTHESIZE the user-facing steps from that documented flow and cite [N]; do not refuse merely because it is framed as an internal spec. IF the passages genuinely do NOT address the asked topic, abstain plainly with no citations. Never state steps that are not supported by the passages.";

/**
 * Normalize a string for refusal-opener comparison: fold every apostrophe
 * variant (U+0027 `'` and U+2019 `’`) to a single ASCII apostrophe, then
 * lower-case. The model frequently emits a typographic apostrophe
 * (`I couldn’t`), so a naive `startsWith` against the ASCII-stored phrase set
 * would miss it — this normalization is what makes the curly form match.
 */
function normalizeForOpener(s: string): string {
  return s.replace(/['’]/g, "'").toLowerCase();
}

/**
 * Resolve the active refusal-opener set. `MONDAY_REFUSAL_OPENERS` (when set and
 * non-empty after parsing) fully REPLACES the defaults; otherwise the defaults
 * apply. Side-effect-free so it can be re-read per call (env may change in
 * tests).
 */
function refusalOpeners(): string[] {
  const raw = process.env.MONDAY_REFUSAL_OPENERS;
  if (!raw) return DEFAULT_REFUSAL_OPENERS;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_REFUSAL_OPENERS;
}

/**
 * Pure detector: true iff `answer`, after trimming leading whitespace, opens
 * (case-insensitively, apostrophe-normalized) with any configured refusal
 * phrase. Defensive: a non-string input is never a refusal opener.
 */
export function opensWithRefusal(answer: string): boolean {
  if (typeof answer !== "string") return false;
  const head = normalizeForOpener(answer.replace(/^\s+/, ""));
  return refusalOpeners().some((phrase) =>
    head.startsWith(normalizeForOpener(phrase)),
  );
}

/** Kill-switch: `MONDAY_REFUSAL_BACKSTOP="0"` disables the regenerate step. */
function backstopEnabled(): boolean {
  return process.env.MONDAY_REFUSAL_BACKSTOP !== "0";
}

/**
 * #1380 granular kill-switch: `MONDAY_HOWTO_BACKSTOP="0"` disables ONLY the
 * how-to hedge class, leaving the #1374 opener class intact. Default ON.
 */
function howToBackstopEnabled(): boolean {
  return process.env.MONDAY_HOWTO_BACKSTOP !== "0";
}

/**
 * #1380 — resolve the active how-to-hedge phrase set. `MONDAY_HOWTO_HEDGE_PHRASES`
 * (when set and non-empty after parsing) fully REPLACES the defaults; otherwise
 * the defaults apply. Side-effect-free so it can be re-read per call.
 */
function howToHedgePhrases(): string[] {
  const raw = process.env.MONDAY_HOWTO_HEDGE_PHRASES;
  if (!raw) return DEFAULT_HOWTO_HEDGE_PHRASES;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_HOWTO_HEDGE_PHRASES;
}

/**
 * #1380 — resolve the coverage-floor score. Reads
 * `MONDAY_HOWTO_COVERAGE_MIN_SCORE`; a finite-number override wins, anything
 * non-finite (unset / NaN / empty) falls back to the measured baked default.
 */
function coverageMinScore(): number {
  const raw = process.env.MONDAY_HOWTO_COVERAGE_MIN_SCORE;
  if (raw === undefined) return DEFAULT_HOWTO_COVERAGE_MIN_SCORE;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_HOWTO_COVERAGE_MIN_SCORE;
}

/**
 * #1380 — retrieval-coverage SIGNAL. True iff the retrieval surfaced genuinely
 * on-topic material, used to GATE the how-to regenerate so a TRUE off-topic
 * abstain can never be silently loosened.
 *
 * - true iff at least one chunk carries a numeric `score >= coverageMinScore()`.
 * - `score` is the cosine similarity threaded by `service.ts → toLlmChunk`
 *   (stays cosine even with rerank/docPrior — those reorder, never overwrite it).
 * - Score-absent fallback (back-compat): if NO chunk carries a numeric `score`
 *   at all (e.g. score-less unit chunks or a future caller), return `true` —
 *   coverage is "unknown, not blocked," so the conditional directive remains the
 *   guard. Production always carries scores, so the gate is real where it matters.
 */
export function hasOnTopicCoverage(chunks: Chunk[]): boolean {
  if (!Array.isArray(chunks) || chunks.length === 0) return false;
  const floor = coverageMinScore();
  let sawScore = false;
  for (const c of chunks) {
    if (typeof c?.score === "number" && Number.isFinite(c.score)) {
      sawScore = true;
      if (c.score >= floor) return true;
    }
  }
  // No numeric score anywhere -> "unknown, not blocked".
  if (!sawScore) console.debug("[hasOnTopicCoverage] fail-open: no numeric score found in %d chunks", chunks.length);
  return sawScore ? false : true;
}

/**
 * #1380 — how-to NON-STEP refusal detector. True iff `text` (a) contains
 * (case-insensitive, substring) any configured how-to-hedge phrase, AND (b)
 * carries NO `[N]` citation marker. The "no `[N]`" condition is load-bearing: it
 * distinguishes the BAD uncited brush-off ("…not user-facing steps", no citation)
 * from the GOOD grounded answer the prompt ENCOURAGES ("the documented process
 * [1] … rather than a tap-by-tap walkthrough", which IS cited) — so an
 * already-grounded answer never trips an extra regenerate.
 */
export function isHowToHedge(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (/\[\d+\]/.test(text)) return false; // cited -> already grounded, not a hedge
  const lower = text.toLowerCase();
  return howToHedgePhrases().some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Pure helper: return ONLY the citations whose `number` actually appears as an
 * inline `[N]` marker in `answer`, keeping their original numbers and order.
 *
 * - Parses the distinct `[N]` markers present in the answer text.
 * - If no `[N]` markers appear (e.g. refusals / NO_CONTEXT_ANSWER), returns [].
 * - Defensive: non-string `answer` or non-array `citations` -> [].
 */
export function selectCitedCitations(
  answer: string,
  citations: Citation[],
): Citation[] {
  if (typeof answer !== "string" || !Array.isArray(citations)) return [];
  const cited = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    cited.add(Number(m[1]));
  }
  if (cited.size === 0) return [];
  return citations.filter((c) => cited.has(c.number));
}

/**
 * Deterministic post-processor for abstention replies.
 *
 * If `answer` OPENS with an abstain phrase ("I couldn't find ...", anchored at
 * start, leading whitespace tolerated, case-insensitive, optional/typographic
 * apostrophe), then: (a) remove every inline `[N]` marker and tidy the leftover
 * spacing, and (b) force `citations` to `[]`. Otherwise return both unchanged.
 *
 * The opener guard is the control: a grounded reply that LEADS with content and
 * only later notes a gap does NOT open with the phrase, so it is untouched.
 *
 * Defensive: a non-string `answer` cannot match the opener -> returned unchanged
 * (no throw, citations normalized to `[]` only when non-array); the type guard
 * runs BEFORE any regex/`.replace` so `undefined` answers never throw.
 */
export function stripStrayAbstainCitations(
  answer: string,
  citations: Citation[],
): AnswerResult {
  if (typeof answer !== "string") {
    return { answer, citations: Array.isArray(citations) ? citations : [] };
  }
  if (!/^\s*I couldn['’]?t find/i.test(answer)) {
    return { answer, citations };
  }
  const cleaned = answer
    .replace(/\s*\[\d+\]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return { answer: cleaned, citations: [] };
}

/**
 * Offline / test-mode flag. When set (or when no Anthropic credentials are
 * available at runtime), `generateAnswer` returns a deterministic fallback
 * answer assembled from the top retrieved chunks instead of calling the LLM.
 *
 * The fallback still exercises the full retrieval+citation pipeline — it only
 * replaces the LLM call. This lets the US-12 e2e ACs run without live API
 * credentials while keeping production behavior unchanged when creds exist.
 */
function isTestMode(): boolean {
  return process.env.MONDAY_TEST_MODE === "1";
}

/**
 * Deterministic offline answer: concatenate the first 1-2 top chunks' text,
 * bolt a `[1]` citation onto the end, and return the canonical citation array.
 * Preserves the contract of `generateAnswer` (same shape, same citation order).
 */
function offlineAnswer(chunks: Chunk[]): AnswerResult {
  const top = chunks.slice(0, 2);
  const body = top
    .map((c) => c.text.trim())
    .filter((t) => t.length > 0)
    .join(" ")
    .trim();
  const answer =
    body.length > 0
      ? `${body} [1]`
      : NO_CONTEXT_ANSWER;
  return compactRenumber(
    answer,
    selectCitedCitations(answer, buildCitations(chunks)),
  );
}

export interface Chunk {
  id: string;
  text: string;
  source: string;
  heading?: string;
  section?: string;
  score?: number;
}

export interface Citation {
  number: number;
  source: string;
  heading?: string;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
}

/**
 * #1375 — shared source numbering. Walk chunks in order and assign the next
 * integer (1, 2, 3 …) to each previously-unseen `source`, reusing the same
 * number whenever that source recurs. The in-text `[N]` markers the model emits
 * refer to THIS numbering, so `formatContext` and `buildCitations` MUST share
 * it — numbering by source in only one of them would desync the answer text
 * from the citation list. (Dedup key = `source`/docId.)
 */
function buildSourceNumbering(chunks: Chunk[]): Map<string, number> {
  const numbering = new Map<string, number>();
  let next = 1;
  for (const c of chunks) {
    if (!numbering.has(c.source)) {
      numbering.set(c.source, next);
      next += 1;
    }
  }
  return numbering;
}

function formatContext(chunks: Chunk[]): string {
  const numbering = buildSourceNumbering(chunks);
  return chunks
    .map((c) => {
      const n = numbering.get(c.source);
      const meta = c.heading
        ? `(source: ${c.source}, heading: ${c.heading})`
        : `(source: ${c.source})`;
      return `[${n}] ${meta}\n${c.text}`;
    })
    .join("\n\n");
}

/**
 * #1375 — one citation per UNIQUE source. Uses the shared numbering so the
 * citation list can never produce two numbers for the same source. The heading
 * is the first NON-EMPTY heading seen for that source (omitted if none).
 * Citations are ordered by assigned number.
 */
export function buildCitations(chunks: Chunk[]): Citation[] {
  const numbering = buildSourceNumbering(chunks);
  const bySource = new Map<string, Citation>();
  for (const c of chunks) {
    const number = numbering.get(c.source)!;
    let entry = bySource.get(c.source);
    if (!entry) {
      entry = { number, source: c.source };
      bySource.set(c.source, entry);
    }
    if (entry.heading === undefined && c.heading) {
      entry.heading = c.heading;
    }
  }
  return [...bySource.values()].sort((a, b) => a.number - b.number);
}

/**
 * #1375 — compact, contiguous renumbering. THE single place an old#→new# map is
 * applied, so the answer text markers and the citation list never diverge.
 *
 * - Defensive: non-string `answer` / non-array `citations` -> `{ answer, [] }`.
 * - Collect old numbers that appear as `[N]` in `answer` AND exist in
 *   `citations`; sort ascending and assign contiguous new numbers 1, 2, 3 ….
 * - Rewrite the answer text in ONE pass via a `/\[(\d+)\]/g` replace callback so
 *   a sequential rewrite can never double-substitute (bracket tokens match
 *   whole, never partially — multi-digit safe).
 * - Rewrite each citation's `number` via the same map; drop any not in the map;
 *   sort by new number.
 */
export function compactRenumber(
  answer: string,
  citations: Citation[],
): AnswerResult {
  if (typeof answer !== "string" || !Array.isArray(citations)) {
    return { answer, citations: [] };
  }
  const present = new Set<number>();
  for (const c of citations) present.add(c.number);

  const cited = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (present.has(n)) cited.add(n);
  }

  const ordered = [...cited].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  ordered.forEach((oldNum, i) => remap.set(oldNum, i + 1));

  const newAnswer = answer.replace(/\[(\d+)\]/g, (whole, digits) => {
    const mapped = remap.get(Number(digits));
    return mapped === undefined ? whole : `[${mapped}]`;
  });

  const newCitations = citations
    .filter((c) => remap.has(c.number))
    .map((c) => ({ ...c, number: remap.get(c.number)! }))
    .sort((a, b) => a.number - b.number);

  return { answer: newAnswer, citations: newCitations };
}

export async function generateAnswer(
  question: string,
  chunks: Chunk[],
): Promise<AnswerResult> {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { answer: NO_CONTEXT_ANSWER, citations: [] };
  }

  // Test-mode short-circuit: skip the LLM entirely and return a deterministic
  // answer assembled from the top chunks. Also used as a graceful fallback
  // when Anthropic credentials are missing (e.g. CI without secrets).
  if (isTestMode()) {
    return offlineAnswer(chunks);
  }

  let client;
  try {
    client = getClient();
  } catch (err) {
    // No credentials: degrade gracefully to offline mode rather than crashing
    // the whole pipeline. Real production deployments will have OAuth or
    // ANTHROPIC_API_KEY configured; this branch is the e2e safety net.
    console.warn(
      `[generateAnswer] no Anthropic credentials, returning offline answer: ${(err as Error).message}`,
    );
    return offlineAnswer(chunks);
  }

  const context = formatContext(chunks);
  // #3323 — strip the name-call BEFORE the model sees the question; upstream
  // (adapters, help gate, exact-key leg, ask log, retrieval) keeps the ORIGINAL
  // text byte-for-byte (B5). The backstop retry below reuses this same cleaned
  // user content for free.
  const cleanedQuestion = stripNameCall(question);
  const userContent =
    `Question: ${cleanedQuestion}\n\n` +
    `Context:\n${context}\n\n` +
    `Answer the question using only facts from the context. Cite each claim with [N].`;

  let text = await callModel(client, userContent);

  // Two-class regenerate backstop. Class 1 (#1374b): chunks present, but the
  // model OPENED with a configured refusal phrase — a likely proper-noun-absence
  // over-refusal. Class 2 (#1380): chunks present AND retrieval has on-topic
  // coverage (score gate) AND the model led with content but hedged in the body
  // ("…internal specs, not user-facing steps") WITHOUT citing — the how-to
  // non-step brush-off. `refusalClass` takes PRECEDENCE: an answer that BOTH
  // opens with a refusal AND carries a how-to hedge routes through the #1374
  // directive (the `howToClass` term is `!refusalClass && …`), keeping the #1374
  // path byte-identical. The coverage gate is what makes loosening safe: a
  // genuinely off-topic (low-score) retrieval has no coverage, so the how-to
  // class never fires and the model's refusal stands. Regenerate ONCE with
  // the matching CONDITIONAL directive; never fabricate.
  const refusalClass = opensWithRefusal(text);
  const howToClass =
    !refusalClass && hasOnTopicCoverage(chunks) && isHowToHedge(text);
  if (
    text.length > 0 &&
    chunks.length > 0 &&
    backstopEnabled() &&
    (refusalClass || (howToClass && howToBackstopEnabled()))
  ) {
    const directive = howToClass ? HOWTO_REGEN_DIRECTIVE : REGEN_DIRECTIVE;
    const harderContent = `${userContent}\n\n${directive}`;
    const retry = await callModel(client, harderContent, "generateAnswer.backstopRetry");
    if (retry.length > 0) text = retry;
  }

  if (text.length === 0) {
    console.warn(
      "[generateAnswer] model returned no text content; returning no-context answer",
    );
    return { answer: NO_CONTEXT_ANSWER, citations: [] };
  }

  const built = buildCitations(chunks); // dedup'd by source
  const cited = selectCitedCitations(text, built); // only cited, may have gaps
  const abst = stripStrayAbstainCitations(text, cited); // genuine-abstain -> []
  return compactRenumber(abst.answer, abst.citations); // contiguous, text+list in sync
}

/**
 * Private helper: one model call returning the trimmed concatenated text of all
 * text blocks. NO sampling parameter is sent — Haiku 5.5 rejects non-default
 * sampling (#3136), and the determinism doctrine (#1195) now rests on prompt
 * wording. The backstop differentiates its retry by the CHANGED directive.
 */
async function callModel(
  client: ReturnType<typeof getClient>,
  userContent: string,
  callSite = "generateAnswer",
): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });
  // #3136 fix 1: a max_tokens stop must be VISIBLE - the reply may be cut
  // mid-sentence and must never be posted as a finished Slack answer silently.
  warnMaxTokensStop(response, callSite);
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("")
    .trim();
}
