/**
 * Pure, deterministic defect categorizer — no I/O, no network, no LLM.
 *
 * Given a defect's text (summary + optional description), an ordered rule table
 * assigns exactly ONE `DefectCategory` by SYMPTOM — the way a user describes what
 * went wrong, not the way a developer would tag the underlying task. The table is
 * evaluated in PRECEDENCE order (first match wins); anything that matches no rule
 * lands in `other` via the fallback. The categorizer is the reusable core EPIC
 * #1280 calls directly (no CLI / env coupling).
 *
 * Rules key ONLY on generic English symptom words (crash / cannot / wrong /
 * missing / button / navigate / slow …) — never on product names, feature names,
 * codenames, hostnames, project/space keys, or colleague identifiers.
 */

/**
 * The defect symptom taxonomy.
 *
 * DECLARATION order below IS the precedence order (highest → lowest), with `other`
 * as the fallback. One ordered set serves as both the readable declaration order
 * and the first-match-wins precedence:
 *
 *   crash-error > cannot-complete > data-incorrect > missing-element >
 *   display-ui > navigation-flow > performance > other
 *
 * The precedence is still asserted directly by the precedence test (via the
 * behavior of a colliding fixture), independent of this array's order.
 */
export type DefectCategory =
  | "crash-error"
  | "cannot-complete"
  | "data-incorrect"
  | "missing-element"
  | "display-ui"
  | "navigation-flow"
  | "performance"
  | "other";

/** Every category value, in precedence/declaration order — seeds a complete tally. */
export const DEFECT_CATEGORIES: readonly DefectCategory[] = [
  "crash-error",
  "cannot-complete",
  "data-incorrect",
  "missing-element",
  "display-ui",
  "navigation-flow",
  "performance",
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

/**
 * Compiled, runtime-supplied extra keyword patterns, keyed by matchable category
 * (every `DefectCategory` EXCEPT `other`, which owns no rule). Each value is a list
 * of already-compiled `RegExp` objects — PLAIN DATA passed IN, so the matcher does
 * ZERO I/O and stays pure (the file read lives in the loader + the shells, #1341).
 * An extension for category C is evaluated at C's EXISTING precedence rank (see
 * `categorizeDefect`), never appended after `other`.
 */
export type CategoryExtensions = Partial<
  Record<Exclude<DefectCategory, "other">, RegExp[]>
>;

interface DefectRule {
  category: Exclude<DefectCategory, "other">;
  name: string;
  /** Keyword/regex over the defect SUMMARY text. */
  text?: RegExp;
  /** Label values (lowercased) that trigger this rule. */
  labels?: string[];
  /** Issuetype names (lowercased) that trigger this rule. */
  issueTypes?: string[];
}

/**
 * Ordered rule table — evaluated top-to-bottom, FIRST MATCH WINS. The order here
 * IS the precedence (see `DEFECT_CATEGORIES`). A defect matching multiple rules
 * resolves to the highest one. Every regex keys ONLY on generic English symptom
 * words; the `labels`/`issueTypes` fields stay on the interface for
 * shape-compatibility but the symptom rules do not rely on them (a symptom is a
 * text phenomenon; corpus labels/issuetypes are product-specific → privacy risk).
 */
const RULES: readonly DefectRule[] = [
  {
    category: "crash-error",
    name: "crash-error:keyword",
    text: /\b(crash(?:e[sd]|ing)?|freeze|frozen|freezing|hang(?:s|ing)?|stuck|anr|force ?clos(?:e|ed|ing)|exception|fatal|reboot(?:s|ed|ing)?|restart(?:s|ed|ing)?|error(?:s|ed)?|bug(?:s|ged)?|glitch)\b/i,
  },
  {
    category: "cannot-complete",
    name: "cannot-complete:keyword",
    text: /\b(can ?not|cant|can.?t|unable|not able|doesn.?t|does not|won.?t|will not|could ?n.?t|would ?n.?t|did ?n.?t|expire[ds]?|fail(?:s|ed|ing|ure)?|not work(?:ing)?|no response|unresponsive|block(?:s|ed)?|disabled|greyed|grayed|stop(?:s|ped|ping)? working|unavailable|reject(?:s|ed|ing)?)\b/i,
  },
  {
    category: "data-incorrect",
    name: "data-incorrect:keyword",
    text: /\b(wrong|incorrect|mismatch|not match|inaccurate|accurate|miscalc(?:ulat\w*)?|invalid|should be|instead of|not correct|calcul\w*|amount|price|fee|total|count|balance|number|value|duplicat\w*|wrongly|null|reflect(?:s|ed|ing)?|update(?:s|d|ing)?|outdated|sync(?:s|ed|ing|hroni\w*)?|reset(?:s|ting)?)\b/i,
  },
  {
    category: "missing-element",
    name: "missing-element:keyword",
    text: /\b(missing|not show(?:n|ing)?|not display(?:ed|ing)?|not appear(?:ing)?|not there|blank|empty|no data|not visible|disappear(?:s|ed|ing)?|absent|without|gone|nothing show)\b/i,
  },
  {
    category: "display-ui",
    name: "display-ui:keyword",
    text: /\b(ui|layout|align(?:ment|ed)?|overlap(?:s|ping|ped)?|cut ?off|button|icon|colou?r|font|spacing|display|design|truncat\w*|responsive|scroll(?:s|ing)?|padding|margin|image|photo|text|label|popup|pop-up|pop ?up|modal|banner|grey|gray|black|white|keyboard|swipe|tap|stack(?:s|ed|ing)?|indicator|toggle|theme)\b/i,
  },
  {
    category: "navigation-flow",
    name: "navigation-flow:keyword",
    text: /\b(navigat\w*|redirect(?:s|ed|ing)?|back button|transition(?:s|ed|ing)?|route(?:s|d|ing)?|deep ?link)\b/i,
  },
  {
    category: "performance",
    name: "performance:keyword",
    text: /\b(slow(?:ness|ly)?|lag(?:s|ging|gy)?|delay(?:s|ed)?|timed? ?out|timeout|loading|performance|takes? (?:too )?long|laggy|spinner|spinning|stutter\w*)\b/i,
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
 * the same `{ category, matchedRule }`. First matching rule in precedence order
 * wins; no match → `{ category: "other", matchedRule: "fallback" }`.
 */
export function categorizeDefect(
  input: DefectInput,
  extraRules?: CategoryExtensions,
): { category: DefectCategory; matchedRule: string } {
  // Match rules on the SUMMARY only. The summary carries the user's symptom
  // signal; the long description boilerplate (e.g. a QA "Actual result: an error
  // occurred." line) would otherwise let a stray keyword steal precedence
  // (#1333). `descriptionText` stays on `DefectInput` for shape-compat with
  // `cli.ts`; it is simply no longer fed to the matcher.
  const text = input.summary ?? "";
  const labels = (input.labels ?? []).map((l) => l.toLowerCase());
  const issueType = (input.issueType ?? "").toLowerCase();

  for (const rule of RULES) {
    if (ruleMatches(rule, text, labels, issueType)) {
      return { category: rule.category, matchedRule: rule.name };
    }
    // Runtime extensions for THIS rule's category are tested immediately after
    // its base rule, i.e. at the category's EXISTING precedence rank (one rule
    // per category). A higher base rule still short-circuits first
    // (first-match-wins unchanged); extensions match the SAME summary `text`,
    // preserving the #1333 summary-only guarantee. The `:ext` suffix makes an
    // extension-driven match observable without leaking the pattern.
    const ext = extraRules?.[rule.category];
    if (ext && ext.some((re) => re.test(text))) {
      return { category: rule.category, matchedRule: `${rule.name}:ext` };
    }
  }
  return { category: "other", matchedRule: "fallback" };
}

/**
 * Categorize a list of defects and aggregate the grouped counts. `counts` is
 * seeded with EVERY category at 0 (so the shape is stable + no category is
 * silently absent), then incremented per result.
 */
export function categorizeAll(
  inputs: DefectInput[],
  extraRules?: CategoryExtensions,
): {
  results: DefectResult[];
  counts: Record<DefectCategory, number>;
} {
  const counts = Object.fromEntries(DEFECT_CATEGORIES.map((c) => [c, 0])) as Record<
    DefectCategory,
    number
  >;
  const results: DefectResult[] = inputs.map((input) => {
    const { category, matchedRule } = categorizeDefect(input, extraRules);
    counts[category] += 1;
    return { key: input.key, category, matchedRule };
  });
  return { results, counts };
}
