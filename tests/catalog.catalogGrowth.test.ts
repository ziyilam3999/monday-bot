import {
  slugSimilarity,
  resolveSnapThreshold,
  dedupCandidate,
  decideGrowth,
  GROWTH_SNAP_THRESHOLD,
  GROWTH_MIN_FUZZY_LEN,
  type GrowthProposal,
} from "../src/catalog/catalogGrowth";

/**
 * #1387 — catalog-growth safety core. Pure, ZERO network. SYNTHETIC fixtures.
 */

const BUCKETS = new Set(["feature-tools", "feature-account"]);

function proposal(p: Partial<GrowthProposal>): GrowthProposal {
  return { parentLeanId: "feature-tools", candidateLabel: "something", confidence: "high", ...p };
}

describe("#1387 — slugSimilarity + resolveSnapThreshold", () => {
  it("identical slugs → 1; totally different → low", () => {
    expect(slugSimilarity("dark-mode", "dark-mode")).toBe(1);
    expect(slugSimilarity("dark-mode", "billing-export")).toBeLessThan(0.5);
  });

  it("#21 resolveSnapThreshold honors flag > env > source default", () => {
    expect(resolveSnapThreshold({ flag: 0.95 })).toBe(0.95);
    expect(resolveSnapThreshold({ env: "0.9" })).toBe(0.9);
    expect(resolveSnapThreshold({ flag: 0.95, env: "0.5" })).toBe(0.95); // flag wins
    expect(resolveSnapThreshold({ env: undefined })).toBe(GROWTH_SNAP_THRESHOLD);
    // Out-of-range override is ignored → next precedence.
    expect(resolveSnapThreshold({ flag: 2, env: "0.7" })).toBe(0.7);
    expect(resolveSnapThreshold({ flag: 0, env: "" })).toBe(GROWTH_SNAP_THRESHOLD);
  });
});

describe("#1387 #16 GOLDEN Snap — long candidate within threshold of an existing child", () => {
  it("snaps to the existing child and mints nothing", () => {
    // "darkmode" vs "dark-mode" → slugs "darkmode" vs "dark-mode": 1 edit / 9 = 0.889 ≥ 0.85.
    const res = dedupCandidate("dark mode", ["dark-modes"]); // 1 edit / 10 = 0.9
    expect(res.action).toBe("snap");
    if (res.action === "snap") expect(res.childId).toBe("dark-modes");
  });
});

describe("#1387 #17 GOLDEN Mint — dissimilar candidate, member bucket, high confidence", () => {
  it("decideGrowth returns mint with the candidate slug + parent", () => {
    const d = decideGrowth(
      proposal({ candidateLabel: "Billing Export", parentLeanId: "feature-tools" }),
      { existingChildSlugs: ["dark-mode", "search"], bucketIds: BUCKETS },
    );
    expect(d.kind).toBe("mint");
    if (d.kind === "mint") {
      expect(d.slug).toBe("billing-export");
      expect(d.parentLeanId).toBe("feature-tools");
    }
  });
});

describe("#1387 #18 GOLDEN Queue parent — null parent", () => {
  it("a null parentLeanId → queue-parent, never mints", () => {
    const d = decideGrowth(
      proposal({ parentLeanId: null, candidateLabel: "Billing Export" }),
      { existingChildSlugs: [], bucketIds: BUCKETS },
    );
    expect(d.kind).toBe("queue-parent");
    if (d.kind === "queue-parent") expect(d.reason).toBe("no-bucket-fit");
  });
});

describe("#1387 #19 GOLDEN Hallucinated parent NON-MEMBER (MED-4)", () => {
  it("a non-member parent → queue-parent, NEVER mint — even dissimilar + high confidence", () => {
    const d = decideGrowth(
      proposal({
        parentLeanId: "feature-hallucinated", // NOT in BUCKETS
        candidateLabel: "Totally New Thing",
        confidence: "high",
      }),
      { existingChildSlugs: ["dark-mode"], bucketIds: BUCKETS },
    );
    expect(d.kind).toBe("queue-parent");
    if (d.kind === "queue-parent") expect(d.reason).toBe("hallucinated-parent");
    // The never-auto-create-a-parent invariant: it is NEVER a mint.
    expect(d.kind).not.toBe("mint");
  });
});

describe("#1387 #20 — short-slug MIN-LENGTH guard (MED-3)", () => {
  it("two short slugs a low threshold WOULD fuzzy-snap are NOT snapped (fuzzy disabled)", () => {
    // sim("api","ami") = 1 - 1/3 = 0.667. At threshold 0.6 a LONG pair snaps...
    expect(GROWTH_MIN_FUZZY_LEN).toBe(6);
    const short = dedupCandidate("api", ["ami"], { threshold: 0.6 });
    expect(short.action).toBe("mint"); // short-slug guard forces mint.

    // ...proving it is the guard (not the threshold): a 7-char pair at the same
    // similarity DOES snap at the same threshold.
    const longPair = dedupCandidate("abcdefg", ["abcdefh"], { threshold: 0.6 }); // 1/7 → 0.857
    expect(longPair.action).toBe("snap");
  });

  it("an EXACT short-slug match still snaps", () => {
    const res = dedupCandidate("api", ["api", "ami"], { threshold: 0.6 });
    expect(res.action).toBe("snap");
    if (res.action === "snap") expect(res.childId).toBe("api");
  });
});

describe("#1387 #21 — runtime threshold override changes snap behavior", () => {
  it("a pair that snaps at 0.85 does NOT snap at 0.95", () => {
    // slugs "dark-mode" vs "dark-mude": 1 edit / 9 = 0.889.
    const atDefault = dedupCandidate("dark mode", ["dark-mude"], { threshold: 0.85 });
    expect(atDefault.action).toBe("snap");
    const atStrict = dedupCandidate("dark mode", ["dark-mude"], { threshold: 0.95 });
    expect(atStrict.action).toBe("mint");
  });
});
