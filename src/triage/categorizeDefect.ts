/**
 * Pure, deterministic defect categorizer — no I/O, no network, no LLM.
 *
 * Given a defect's structural signals (summary + description text + labels +
 * issuetype), an ordered rule table assigns exactly ONE `DefectCategory`. The
 * table is evaluated in PRECEDENCE order (first match wins); anything that
 * matches no rule lands in `other` via the fallback. The categorizer is the
 * reusable core EPIC #1280 calls directly (no CLI / env coupling).
 *
 * Rules key ONLY on generic structural tokens (defect-type words, public
 * Atlassian field/label/issuetype names) — never on internal hostnames,
 * project/space keys, codenames, or colleague identifiers.
 */

/**
 * The defect taxonomy.
 *
 * IMPORTANT: the DECLARATION order below is an arbitrary, readable order and is
 * INTENTIONALLY NOT the precedence order. Tie-breaking uses a SEPARATE precedence
 * defined by `RULES` below (`correctness-bug > type-safety > test-infra >
 * code-quality > documentation > enhancement > other`). Do NOT "align" the two —
 * they are deliberately distinct, and AC-5 asserts the precedence directly.
 */
export type DefectCategory =
  | "correctness-bug"
  | "code-quality"
  | "documentation"
  | "test-infra"
  | "type-safety"
  | "enhancement"
  | "other";

/** Every category value, in declaration order — used to seed a complete tally. */
export const DEFECT_CATEGORIES: readonly DefectCategory[] = [
  "correctness-bug",
  "code-quality",
  "documentation",
  "test-infra",
  "type-safety",
  "enhancement",
  "other",
];

/** Categorizer input — maps trivially from a `JiraIssue`. */
export interface DefectInput {
  key?: string;
  summary: string;
  descriptionText?: string;
  labels?: string[];
  issueType?: string;
}

/** A single categorized defect. */
export interface DefectResult {
  key?: string;
  category: DefectCategory;
  matchedRule: string;
}

interface DefectRule {
  category: Exclude<DefectCategory, "other">;
  name: string;
  /** Keyword/regex over the combined text (summary + description). */
  text?: RegExp;
  /** Label values (lowercased) that trigger this rule. */
  labels?: string[];
  /** Issuetype names (lowercased) that trigger this rule. */
  issueTypes?: string[];
}

/**
 * Ordered rule table — evaluated top-to-bottom, FIRST MATCH WINS. The order here
 * IS the precedence: correctness-bug > type-safety > test-infra > code-quality >
 * documentation > enhancement. A defect matching multiple rules resolves to the
 * highest one (AC-5). Nothing here keys on `issueType: "Bug"` alone, so a
 * type-safety task tagged Bug is not swallowed by correctness-bug.
 */
const RULES: readonly DefectRule[] = [
  {
    category: "correctness-bug",
    name: "correctness-bug:keyword",
    text: /\b(crash(?:es|ed)?|broken|incorrect|wrong|regress(?:ion|es|ed)?|exception|throws?|swallow(?:s|ed)?|hang(?:s|ed)?|deadlock|race condition|memory leak|null pointer|npe|returns? empty|infinite loop|off-by-one|corrupt(?:s|ed|ion)?|fails?|failing|errors?)\b/i,
    labels: ["bug"],
  },
  {
    category: "type-safety",
    name: "type-safety:keyword",
    text: /\b(type|types|typing|typed|typecheck|type-safety|typesafe|cast|casting|generic|generics|nullable|non-null|narrow(?:ing)?)\b/i,
    labels: ["type-safety", "typing"],
  },
  {
    category: "test-infra",
    name: "test-infra:keyword",
    text: /\b(test|tests|testing|spec|specs|mock(?:s|ed)?|fixture|fixtures|ci|flaky|hoist|test-runner|jest|snapshot|e2e|coverage|stub|stubs)\b/i,
    labels: ["test", "test-infra", "ci"],
  },
  {
    category: "code-quality",
    name: "code-quality:keyword",
    text: /\b(refactor(?:ing)?|dedupe|deduplicate|duplicat(?:e|ed|ion)|cleanup|clean up|rename|extract|simplify|lint|tidy|consolidate|readability|dead code)\b/i,
    labels: ["refactor", "chore", "tech-debt"],
  },
  {
    category: "documentation",
    name: "documentation:keyword",
    text: /\b(doc|docs|document|documentation|readme|changelog|comment|comments|typo|wording|link|links|guide|tutorial|docstring|javadoc)\b/i,
    labels: ["docs", "documentation"],
  },
  {
    category: "enhancement",
    name: "enhancement:keyword",
    text: /\b(add|adds|added|feature|features|support|enhance(?:ment)?|improve(?:ment)?|introduce|new|option|optional|knob|configurable|extend)\b/i,
    labels: ["enhancement", "feature"],
    issueTypes: ["story", "epic", "new feature", "feature"],
  },
];

function ruleMatches(rule: DefectRule, text: string, labels: string[], issueType: string): boolean {
  if (rule.text && rule.text.test(text)) return true;
  if (rule.labels && rule.labels.some((l) => labels.includes(l))) return true;
  if (rule.issueTypes && issueType.length > 0 && rule.issueTypes.includes(issueType)) return true;
  return false;
}

/**
 * Categorize a single defect. Deterministic + pure: the same input always yields
 * the same `{ category, matchedRule }` (AC-4). First matching rule in precedence
 * order wins (AC-5); no match → `{ category: "other", matchedRule: "fallback" }`.
 */
export function categorizeDefect(input: DefectInput): { category: DefectCategory; matchedRule: string } {
  const text = `${input.summary ?? ""} ${input.descriptionText ?? ""}`;
  const labels = (input.labels ?? []).map((l) => l.toLowerCase());
  const issueType = (input.issueType ?? "").toLowerCase();

  for (const rule of RULES) {
    if (ruleMatches(rule, text, labels, issueType)) {
      return { category: rule.category, matchedRule: rule.name };
    }
  }
  return { category: "other", matchedRule: "fallback" };
}

/**
 * Categorize a list of defects and aggregate the grouped counts. `counts` is
 * seeded with EVERY category at 0 (so the shape is stable + no category is
 * silently absent), then incremented per result (AC-6).
 */
export function categorizeAll(inputs: DefectInput[]): {
  results: DefectResult[];
  counts: Record<DefectCategory, number>;
} {
  const counts = Object.fromEntries(DEFECT_CATEGORIES.map((c) => [c, 0])) as Record<
    DefectCategory,
    number
  >;
  const results: DefectResult[] = inputs.map((input) => {
    const { category, matchedRule } = categorizeDefect(input);
    counts[category] += 1;
    return { key: input.key, category, matchedRule };
  });
  return { results, counts };
}
