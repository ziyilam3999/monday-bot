/**
 * Production feature/flow matcher core (#1343, EPIC #1064).
 *
 * Implements the EXISTING `IssueFeatureFlowClassifier` seam
 * (`src/triage/classifier.ts`): given one issue's text, pick exactly ONE feature
 * id and zero-or-more flow ids FROM THE INJECTED CATALOG MENU. It mirrors the
 * `build-catalog.js` LLM-boundary pattern (model from env, `temperature: 0`,
 * JSON-from-text parse, counts-only logging) but factors the actual model call
 * out into an INJECTED `complete(prompt) → string` seam, so this core is unit-
 * tested with a FAKE and makes ZERO network / model / cred calls.
 *
 * Two independent guards keep a defect the model can't place UNLABELED rather
 * than mislabeled:
 *   1. Matcher-side confidence floor (here): `confidence: "low"` OR a null/absent
 *      feature ⇒ `feature: undefined`; a low-confidence / empty flow list ⇒
 *      `flows: []`.
 *   2. Catalog-membership gate (downstream, `buildDesiredLabels`): any id NOT in
 *      the catalog is rejected before a label is ever constructed.
 *
 * Privacy: the catalog carries INTERNAL product names; they feed ONLY the in-
 * prompt menu and are NEVER logged or printed. This module does no fs / network.
 */
import type { JiraIssue } from "../jira/sync";
import type { IssueFeatureFlowClassifier } from "./classifier";

/** Minimal catalog shape the matcher needs (each entry: id + human label). */
export interface MatcherCatalogEntry {
  id: string;
  label: string;
}
export interface MatcherCatalog {
  features: ReadonlyArray<MatcherCatalogEntry>;
  flows: ReadonlyArray<MatcherCatalogEntry>;
}

/** Structural subset of an issue the matcher reads (summary + description only). */
export interface MatcherIssue {
  summary: string;
  descriptionText?: string;
}

/**
 * The SINGLE LLM boundary of the matcher: a thin `complete(prompt) → text`
 * function. The production wrapper (in the eval / backfill shells) wraps
 * `getClient().messages.create(...)`; tests inject a fake returning canned JSON.
 */
export type CompleteFn = (prompt: string) => Promise<string>;

/** The matcher's verdict — exactly the `IssueFeatureFlowClassifier` contract. */
export interface MatchResult {
  feature?: string;
  flows: string[];
}

/**
 * Build the static "menu" + per-issue prompt. The menu lists every catalog
 * feature id + its human label, then every flow id + its label; the model must
 * answer with ids FROM THE MENU ONLY, as strict JSON. `temperature: 0` upstream
 * keeps it deterministic.
 */
export function buildMatcherPrompt(catalog: MatcherCatalog, issue: MatcherIssue): string {
  const featureMenu = catalog.features.map((e) => `  - ${e.id}: ${e.label}`).join("\n");
  const flowMenu = catalog.flows.map((e) => `  - ${e.id}: ${e.label}`).join("\n");
  const description = (issue.descriptionText ?? "").trim();
  return [
    "You categorize a software defect against a fixed product catalog.",
    "",
    "FEATURES (pick the single best-fitting id, or null):",
    featureMenu || "  (none)",
    "",
    "FLOWS (pick any ids that clearly apply, zero or more):",
    flowMenu || "  (none)",
    "",
    "Rules:",
    "- Use ONLY ids from the menus above. Never invent an id.",
    "- Pick the SINGLE best feature id. If none clearly fits, return null.",
    "- Pick zero-or-more flow ids that clearly apply.",
    '- If you are not confident, set "confidence":"low" rather than guessing.',
    '- Respond with STRICT JSON ONLY: {"feature":"<id|null>","flows":["<id>"...],"confidence":"high|low"}',
    "",
    "DEFECT:",
    `summary: ${issue.summary}`,
    description ? `description: ${description}` : "description: (none)",
  ].join("\n");
}

/** Parse the model's JSON reply the same way `build-catalog.js` does. */
function parseMatcherReply(text: string): {
  feature: string | null;
  flows: string[];
  confidence: string;
} {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("feature-flow matcher: model reply contained no JSON object");
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    feature?: unknown;
    flows?: unknown;
    confidence?: unknown;
  };
  const feature = typeof parsed.feature === "string" && parsed.feature !== "" ? parsed.feature : null;
  const flows = Array.isArray(parsed.flows)
    ? parsed.flows.filter((f): f is string => typeof f === "string" && f !== "")
    : [];
  const confidence = typeof parsed.confidence === "string" ? parsed.confidence.toLowerCase() : "high";
  return { feature, flows, confidence };
}

/**
 * Match ONE issue to a feature + flows via the injected `complete` seam, applying
 * the confidence floor. A low-confidence or null verdict yields a clean "none"
 * (`feature: undefined`, `flows: []`) — the matcher emits nothing rather than
 * guess. The returned ids are RAW catalog ids; `buildDesiredLabels` validates +
 * prefixes them downstream.
 */
export async function matchFeatureFlow(
  catalog: MatcherCatalog,
  complete: CompleteFn,
  issue: MatcherIssue,
): Promise<MatchResult> {
  const prompt = buildMatcherPrompt(catalog, issue);
  const text = await complete(prompt);
  const reply = parseMatcherReply(text);

  // Confidence floor: a low-confidence verdict is treated as "none" on BOTH axes
  // (do not stamp a feature/flow the model isn't sure about).
  if (reply.confidence === "low") {
    return { feature: undefined, flows: [] };
  }
  return {
    feature: reply.feature ?? undefined,
    flows: reply.flows,
  };
}

/**
 * Adapt the matcher core to the production `IssueFeatureFlowClassifier` seam the
 * backfill consumes. The `complete` seam + catalog are injected by the SHELL
 * (which wires the real model); tests inject a fake.
 */
export function buildFeatureFlowClassifier(
  catalog: MatcherCatalog,
  complete: CompleteFn,
): IssueFeatureFlowClassifier {
  return {
    async classify(issue: JiraIssue): Promise<MatchResult> {
      return matchFeatureFlow(catalog, complete, {
        summary: issue.summary,
        descriptionText: issue.descriptionText,
      });
    },
  };
}
