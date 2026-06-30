/**
 * Catalog-growth PROPOSER seam + adapter (#1387).
 *
 * Mirrors `featureFlowMatcher`: a thin INJECTED `complete(prompt) → text`
 * boundary, `temperature: 0` upstream, strict-JSON-from-text parse, counts-only
 * logging. Given an abstaining issue + the EXISTING bucket menu, the model
 * (a) picks the best-fitting EXISTING parent bucket (or null) and (b) proposes a
 * human-readable child label. The pick is UNTRUSTED — `decideGrowth`
 * (`catalogGrowth.ts`) validates the parent against the real bucket set before
 * anything is written.
 *
 * Privacy: the bucket menu carries internal names → IN-PROMPT ONLY, never
 * logged. No fs / network here — tests inject a fake `complete`.
 */
import type { CompleteFn, MatcherIssue } from "./featureFlowMatcher";
import type { GrowthProposal } from "../catalog/catalogGrowth";

/** One bucket the model may pick from (lean id + human label). */
export interface BucketMenuEntry {
  id: string;
  label: string;
}

/**
 * Build the proposer prompt: list every EXISTING bucket id + label, then demand
 * the model pick ONE existing id (or null) + propose a child label, as STRICT
 * JSON. It must NEVER invent a bucket id.
 */
export function buildProposerPrompt(
  bucketMenu: readonly BucketMenuEntry[],
  issue: MatcherIssue,
): string {
  const menu = bucketMenu.map((e) => `  - ${e.id}: ${e.label}`).join("\n");
  const description = (issue.descriptionText ?? "").trim();
  return [
    "A software defect did NOT fit any existing catalog feature. Propose a NEW",
    "child feature for it under ONE of the EXISTING parent buckets below.",
    "",
    "PARENT BUCKETS (pick the single best-fitting id, or null if none fits):",
    menu || "  (none)",
    "",
    "Rules:",
    "- Use ONLY a bucket id from the menu above. NEVER invent a bucket id.",
    "- If no bucket clearly fits, set \"parentLeanId\":null (a human will review).",
    "- Propose a SHORT human-readable child label for the new feature.",
    '- If you are not confident, set "confidence":"low" rather than guessing.',
    '- Respond with STRICT JSON ONLY: {"parentLeanId":"<id|null>","candidateLabel":"<label>","confidence":"high|low"}',
    "",
    "DEFECT:",
    `summary: ${issue.summary}`,
    description ? `description: ${description}` : "description: (none)",
  ].join("\n");
}

/** Parse the model's strict-JSON reply into a `GrowthProposal`. */
export function parseProposerReply(text: string): GrowthProposal {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("growth proposer: model reply contained no JSON object");
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    parentLeanId?: unknown;
    candidateLabel?: unknown;
    confidence?: unknown;
  };
  const parentLeanId =
    typeof parsed.parentLeanId === "string" && parsed.parentLeanId !== ""
      ? parsed.parentLeanId
      : null;
  const candidateLabel =
    typeof parsed.candidateLabel === "string" ? parsed.candidateLabel : "";
  const confidence = parsed.confidence === "high" ? "high" : "low";
  return { parentLeanId, candidateLabel, confidence };
}

/**
 * Propose a NEW child for one abstaining issue via the injected `complete` seam.
 * The returned proposal is UNTRUSTED — `decideGrowth` gates it. ZERO network in
 * tests (fake `complete`).
 */
export async function proposeChild(
  complete: CompleteFn,
  bucketMenu: readonly BucketMenuEntry[],
  issue: MatcherIssue,
): Promise<GrowthProposal> {
  const prompt = buildProposerPrompt(bucketMenu, issue);
  const text = await complete(prompt);
  return parseProposerReply(text);
}
