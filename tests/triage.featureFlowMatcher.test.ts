import {
  matchFeatureFlow,
  buildMatcherPrompt,
  buildFeatureFlowClassifier,
  type MatcherCatalog,
  type CompleteFn,
} from "../src/triage/featureFlowMatcher";
import type { JiraIssue } from "../src/jira/sync";

/**
 * #1343 — feature/flow matcher core (AC-3 / AC-4).
 *
 * SYNTHETIC fixtures ONLY. The model boundary is an INJECTED fake `complete`, so
 * these tests make ZERO network / model / cred calls and never import getClient.
 */

const CATALOG: MatcherCatalog = {
  features: [
    { id: "feature-checkout", label: "Checkout" },
    { id: "feature-search", label: "Search" },
  ],
  flows: [
    { id: "flow-signup", label: "Sign up" },
    { id: "flow-payment", label: "Payment" },
  ],
};

/** A fake `complete` that always returns the same canned JSON reply. */
function fakeComplete(canned: string): CompleteFn {
  return async () => canned;
}

const ISSUE = { summary: "card declined at checkout", descriptionText: "tried twice" };

describe("AC-3 — matcher maps a confident reply to feature + flows (fake complete)", () => {
  it("returns the model's feature id and flow ids on a high-confidence reply", async () => {
    const complete = fakeComplete(
      '{"feature":"feature-checkout","flows":["flow-payment"],"confidence":"high"}',
    );
    const result = await matchFeatureFlow(CATALOG, complete, ISSUE);
    expect(result).toEqual({ feature: "feature-checkout", flows: ["flow-payment"] });
  });

  it("tolerates prose around the JSON object (indexOf/lastIndexOf parse)", async () => {
    const complete = fakeComplete(
      'Sure! Here is the answer:\n{"feature":"feature-search","flows":[],"confidence":"high"}\nThanks.',
    );
    const result = await matchFeatureFlow(CATALOG, complete, ISSUE);
    expect(result).toEqual({ feature: "feature-search", flows: [] });
  });

  it("builds a menu prompt that lists every catalog id (model picks from the menu)", () => {
    const prompt = buildMatcherPrompt(CATALOG, ISSUE);
    expect(prompt).toContain("feature-checkout");
    expect(prompt).toContain("feature-search");
    expect(prompt).toContain("flow-signup");
    expect(prompt).toContain("flow-payment");
    expect(prompt).toContain("card declined at checkout");
  });

  it("adapts to the IssueFeatureFlowClassifier seam over a JiraIssue", async () => {
    const complete = fakeComplete(
      '{"feature":"feature-checkout","flows":["flow-payment"],"confidence":"high"}',
    );
    const classifier = buildFeatureFlowClassifier(CATALOG, complete);
    const issue: JiraIssue = {
      key: "DEMO-1",
      summary: "card declined at checkout",
      descriptionText: "tried twice",
      commentTexts: [],
    };
    const result = await classifier.classify(issue);
    expect(result).toEqual({ feature: "feature-checkout", flows: ["flow-payment"] });
  });
});

describe("AC-4 — confidence floor returns a clean 'none'", () => {
  it('confidence "low" → { feature: undefined, flows: [] } (even if ids are present)', async () => {
    const complete = fakeComplete(
      '{"feature":"feature-checkout","flows":["flow-payment"],"confidence":"low"}',
    );
    const result = await matchFeatureFlow(CATALOG, complete, ISSUE);
    expect(result).toEqual({ feature: undefined, flows: [] });
  });

  it("null feature → feature undefined (flows still pass through)", async () => {
    const complete = fakeComplete('{"feature":null,"flows":["flow-payment"],"confidence":"high"}');
    const result = await matchFeatureFlow(CATALOG, complete, ISSUE);
    expect(result).toEqual({ feature: undefined, flows: ["flow-payment"] });
  });

  it("absent feature key → feature undefined", async () => {
    const complete = fakeComplete('{"flows":[],"confidence":"high"}');
    const result = await matchFeatureFlow(CATALOG, complete, ISSUE);
    expect(result).toEqual({ feature: undefined, flows: [] });
  });

  it("throws a structured error when the reply carries no JSON object", async () => {
    const complete = fakeComplete("I cannot answer that.");
    await expect(matchFeatureFlow(CATALOG, complete, ISSUE)).rejects.toThrow(/no JSON object/);
  });
});
