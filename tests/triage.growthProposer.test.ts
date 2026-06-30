import {
  buildProposerPrompt,
  parseProposerReply,
  proposeChild,
  type BucketMenuEntry,
} from "../src/triage/growthProposer";
import { decideGrowth } from "../src/catalog/catalogGrowth";
import type { CompleteFn } from "../src/triage/featureFlowMatcher";

/**
 * #1387 — growth proposer seam. SYNTHETIC fixtures; the model boundary is an
 * INJECTED fake `complete`, so ZERO network / model / cred calls.
 */
const BUCKET_MENU: BucketMenuEntry[] = [
  { id: "feature-tools", label: "Tools" },
  { id: "feature-account", label: "Account" },
];
const ISSUE = { summary: "cannot toggle the new widget", descriptionText: "broken" };

function fakeComplete(canned: string): CompleteFn {
  return async () => canned;
}

describe("#1387 #22 — buildProposerPrompt lists buckets, demands strict JSON, never invents", () => {
  it("includes every bucket id + label and the strict-JSON contract", () => {
    const prompt = buildProposerPrompt(BUCKET_MENU, ISSUE);
    expect(prompt).toContain("feature-tools");
    expect(prompt).toContain("Tools");
    expect(prompt).toContain("feature-account");
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).toContain("NEVER invent a bucket id");
    expect(prompt).toContain("cannot toggle the new widget");
  });
});

describe("#1387 #23 — parse + abstain (fake complete, zero network)", () => {
  it("parses a high-confidence reply to a usable proposal", async () => {
    const complete = fakeComplete(
      '{"parentLeanId":"feature-tools","candidateLabel":"Dark Mode","confidence":"high"}',
    );
    const p = await proposeChild(complete, BUCKET_MENU, ISSUE);
    expect(p).toEqual({
      parentLeanId: "feature-tools",
      candidateLabel: "Dark Mode",
      confidence: "high",
    });
  });

  it("a null-parent / low-confidence reply parses to a queue decision", async () => {
    const complete = fakeComplete(
      'Sure:\n{"parentLeanId":null,"candidateLabel":"Mystery","confidence":"low"}\nDone.',
    );
    const p = await proposeChild(complete, BUCKET_MENU, ISSUE);
    expect(p.parentLeanId).toBeNull();
    expect(p.confidence).toBe("low");
    const d = decideGrowth(p, {
      existingChildSlugs: [],
      bucketIds: new Set(["feature-tools", "feature-account"]),
    });
    expect(d.kind).toBe("queue-parent");
  });

  it("throws a structured error when the reply carries no JSON object", () => {
    expect(() => parseProposerReply("I cannot answer that.")).toThrow(/no JSON object/);
  });
});
