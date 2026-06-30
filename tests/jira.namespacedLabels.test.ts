import { slug } from "../src/catalog/slug";
import {
  buildDesiredLabels,
  buildBotLabelJql,
  membershipFromCatalog,
  LabelValidationError,
  LabelCatalog,
} from "../src/jira/namespacedLabels";
import { buildJiraNamespacedLabelWriter } from "../src/jira/namespacedLabelWriter";
import { DEFECT_CATEGORIES } from "../src/triage/categorizeDefect";

/** #1387 — DUAL labels (child + parent bucket) + PARTIAL validation. */
describe("#1387 — DUAL child+parent bucket labels", () => {
  const PARENT_OF = new Map<string, string>([
    ["feature-widget", "feature-tools"],
    ["flow-onboarding", "flow-account"],
  ]);
  const CATALOG: LabelCatalog = {
    featureIds: new Set(["feature-widget"]),
    flowIds: new Set(["flow-onboarding"]),
    parentOf: PARENT_OF,
  };

  it("#1 happy path: child + parent bucket on BOTH axes + symptom", () => {
    const v = buildDesiredLabels(
      { feature: "feature-widget", flows: ["flow-onboarding"], symptom: "crash-error" },
      CATALOG,
      undefined,
      () => {},
    );
    expect(v.desired).toEqual(
      expect.arrayContaining([
        "mb-feature-widget",
        "mb-bucket-feature-tools",
        "mb-flow-onboarding",
        "mb-bucket-flow-account",
        "mb-symptom-crash-error",
      ]),
    );
    expect(v.featureBucket).toBe("mb-bucket-feature-tools");
    expect(v.flowBuckets).toEqual(["mb-bucket-flow-account"]);
  });

  it("#2 child with no map entry → child present, NO bucket, no throw, axis-only log", () => {
    const logs: string[] = [];
    const catalog: LabelCatalog = {
      featureIds: new Set(["feature-orphan"]),
      flowIds: new Set(),
      parentOf: new Map(), // feature-orphan absent from the map.
    };
    const v = buildDesiredLabels(
      { feature: "feature-orphan", flows: [], symptom: "crash-error" },
      catalog,
      undefined,
      (m) => logs.push(m),
    );
    expect(v.feature).toBe("mb-feature-orphan");
    expect(v.featureBucket).toBeUndefined();
    expect(v.desired.some((l) => l.startsWith("mb-bucket-"))).toBe(false);
    expect(logs.some((l) => l.includes("no parent-bucket mapping"))).toBe(true);
    expect(logs.join("\n")).not.toContain("orphan");
  });

  it("#3 two flows → same bucket de-duped to exactly one", () => {
    const catalog: LabelCatalog = {
      featureIds: new Set(),
      flowIds: new Set(["flow-a", "flow-b"]),
      parentOf: new Map([
        ["flow-a", "flow-shared"],
        ["flow-b", "flow-shared"],
      ]),
    };
    const v = buildDesiredLabels(
      { flows: ["flow-a", "flow-b"], symptom: "crash-error" },
      catalog,
      undefined,
      () => {},
    );
    const buckets = v.desired.filter((l) => l === "mb-bucket-flow-shared");
    expect(buckets).toEqual(["mb-bucket-flow-shared"]);
    expect(v.flowBuckets).toEqual(["mb-bucket-flow-shared"]);
  });

  it("#7 backward-compat: NO parentOf → child + symptom only (no bucket)", () => {
    const catalog: LabelCatalog = {
      featureIds: new Set(["feature-widget"]),
      flowIds: new Set(["flow-onboarding"]),
    };
    const v = buildDesiredLabels(
      { feature: "feature-widget", flows: ["flow-onboarding"], symptom: "crash-error" },
      catalog,
      undefined,
      () => {},
    );
    expect(v.desired.some((l) => l.startsWith("mb-bucket-"))).toBe(false);
    expect(v.featureBucket).toBeUndefined();
    expect(v.flowBuckets).toEqual([]);
  });
});

describe("#1387 — PARTIAL validation (keep valid, drop invalid; all-invalid still throws)", () => {
  const CATALOG: LabelCatalog = {
    featureIds: new Set(["feature-widget"]),
    flowIds: new Set(["flow-onboarding"]),
  };

  it("#4 GOLDEN partial-keep: bad feature dropped, valid flow kept, no throw", () => {
    const logs: string[] = [];
    const v = buildDesiredLabels(
      { feature: "feature-nope", flows: ["flow-onboarding"], symptom: "crash-error" },
      CATALOG,
      undefined,
      (m) => logs.push(m),
    );
    expect(v.feature).toBeUndefined();
    expect(v.flows).toEqual(["mb-flow-onboarding"]);
    expect(v.droppedCount).toBe(1);
    expect(v.desired).toContain("mb-symptom-crash-error");
    // Log names only the axis, never the supplied value.
    expect(logs.some((l) => l.includes("dropped invalid feature"))).toBe(true);
    expect(logs.join("\n")).not.toContain("nope");
  });

  it("#5 GOLDEN all-invalid: every supplied member invalid → throws (guard NOT weakened)", () => {
    const logs: string[] = [];
    expect(() =>
      buildDesiredLabels(
        { feature: "feature-nope", flows: ["flow-nope"], symptom: "crash-error" },
        CATALOG,
        undefined,
        (m) => logs.push(m),
      ),
    ).toThrow(LabelValidationError);
    expect(logs.join("\n")).not.toContain("nope");
  });

  it("#6 symptom-only (no feature, empty flows): no throw, symptom-only desired", () => {
    const v = buildDesiredLabels(
      { flows: [], symptom: "crash-error" },
      CATALOG,
      undefined,
      () => {},
    );
    expect(v.feature).toBeUndefined();
    expect(v.flows).toEqual([]);
    expect(v.droppedCount).toBe(0);
    expect(v.desired).toEqual(["mb-symptom-crash-error"]);
  });

  it("partial-keep on the FLOW axis: one bad flow dropped, valid flow kept", () => {
    const v = buildDesiredLabels(
      { flows: ["flow-onboarding", "flow-nope"], symptom: "crash-error" },
      CATALOG,
      undefined,
      () => {},
    );
    expect(v.flows).toEqual(["mb-flow-onboarding"]);
    expect(v.droppedCount).toBe(1);
  });
});

describe("#1387 — buildBotLabelJql enumerates parent buckets too", () => {
  it("#8 includes mb-bucket-* for each supplied lean id, sorted, quoted, no wildcard", () => {
    const catalog = {
      features: [{ id: "feature-widget" }],
      flows: [{ id: "flow-onboarding" }],
    };
    const jql = buildBotLabelJql(catalog, undefined, ["feature-tools", "flow-account"]);
    expect(jql).not.toContain("*");
    expect(jql).toContain('"mb-bucket-feature-tools"');
    expect(jql).toContain('"mb-bucket-flow-account"');
  });
});

/**
 * #1322 — bot-namespaced Jira labels (mb-feature / mb-flow / mb-symptom).
 *
 * SYNTHETIC fixtures ONLY: example.atlassian.net, a DEMO project key, and
 * invented slugs. ZERO live mutation — every write goes through an injected fake
 * `fetchImpl`.
 */

const CONFIG = { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" };

function okFetchSpy(): jest.Mock {
  return jest.fn(async () => ({
    ok: true,
    status: 204,
    statusText: "No Content",
    async json() {
      return {};
    },
  }));
}

describe("AC-3 — shared slug canonicalization + single-source", () => {
  it("turns messy inputs into lowercase-kebab", () => {
    expect(slug("  Sign In!! ")).toBe("sign-in");
    expect(slug("Check—out  Flow")).toBe("check-out-flow");
  });

  it("the label model canonicalizes via the SAME slug the catalog uses", () => {
    const messy = "  Sign In!! ";
    const catalog: LabelCatalog = {
      featureIds: new Set([`feature-${slug(messy)}`]),
      flowIds: new Set(),
    };
    const v = buildDesiredLabels({ feature: messy, flows: [], symptom: "crash-error" }, catalog);
    // Same symbol → the label slug equals the catalog id slug, deterministically.
    expect(v.feature).toBe(`mb-feature-${slug(messy)}`);
    expect(v.feature).toBe("mb-feature-sign-in");
  });
});

describe("AC-4 — exactly-one single-value label, ALL stale removed before add", () => {
  it("removes BOTH stale mb-feature-* labels + one add, human label untouched", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);
    const target = buildDesiredLabels(
      { feature: "new", flows: [], symptom: "crash-error" },
      { featureIds: new Set(["feature-new"]), flowIds: new Set() },
    );

    const didPut = await writer.applyLabels(
      "DEMO-1",
      ["mb-feature-old", "mb-feature-older", "keep-me"],
      target,
    );
    expect(didPut).toBe(true);

    const init = fetchImpl.mock.calls[0][1] as { body: string };
    const ops = JSON.parse(init.body).update.labels as Array<{ add?: string; remove?: string }>;

    expect(ops).toContainEqual({ remove: "mb-feature-old" });
    expect(ops).toContainEqual({ remove: "mb-feature-older" });
    // Exactly one mb-feature-* add (a "remove only the first match" bug would
    // still pass the add check but FAIL the two-remove check above).
    const featureAdds = ops.filter((o) => o.add && o.add.startsWith("mb-feature-"));
    expect(featureAdds).toEqual([{ add: "mb-feature-new" }]);
    // Human label never appears in any op.
    expect(JSON.stringify(ops)).not.toContain("keep-me");
  });

  it("mirrors for double-stale mb-symptom-* labels", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);
    const target = buildDesiredLabels(
      { flows: [], symptom: "crash-error" },
      { featureIds: new Set(), flowIds: new Set() },
    );

    const didPut = await writer.applyLabels(
      "DEMO-2",
      ["mb-symptom-old", "mb-symptom-older", "keep-me"],
      target,
    );
    expect(didPut).toBe(true);

    const init = fetchImpl.mock.calls[0][1] as { body: string };
    const ops = JSON.parse(init.body).update.labels as Array<{ add?: string; remove?: string }>;

    expect(ops).toContainEqual({ remove: "mb-symptom-old" });
    expect(ops).toContainEqual({ remove: "mb-symptom-older" });
    const symptomAdds = ops.filter((o) => o.add && o.add.startsWith("mb-symptom-"));
    expect(symptomAdds).toEqual([{ add: "mb-symptom-crash-error" }]);
    expect(JSON.stringify(ops)).not.toContain("keep-me");
  });
});

describe("AC-5 (model) — catalog validation refuses unknown, fail-loud", () => {
  const catalog: LabelCatalog = {
    featureIds: new Set(["feature-known"]),
    flowIds: new Set(["flow-known"]),
  };

  it("throws + fail-loud-logs (axis only) on an unknown feature", () => {
    const logs: string[] = [];
    expect(() =>
      buildDesiredLabels(
        { feature: "nope", flows: [], symptom: "crash-error" },
        catalog,
        undefined,
        (m) => logs.push(m),
      ),
    ).toThrow(LabelValidationError);
    expect(logs.some((l) => l.includes("REJECTED unknown feature"))).toBe(true);
    // Fail-loud line names only the axis, never the value (PUBLIC repo).
    expect(logs.join("\n")).not.toContain("nope");
  });

  it("throws on an unknown flow", () => {
    expect(() =>
      buildDesiredLabels({ flows: ["nope"], symptom: "crash-error" }, catalog, undefined, () => {}),
    ).toThrow(LabelValidationError);
  });

  it("throws on an unknown symptom", () => {
    expect(() =>
      buildDesiredLabels({ flows: [], symptom: "explode" }, catalog, undefined, () => {}),
    ).toThrow(LabelValidationError);
  });
});

describe("#1381 — buildDesiredLabels accepts CANONICAL ids (matcher output), no double-prefix", () => {
  // The matcher (featureFlowMatcher) returns canonical catalog ids
  // (`feature-<slug>` / `flow-<slug>`), NOT bare names. The old code re-prefixed
  // them to `feature-feature-<slug>` and rejected EVERY real pick. These cases
  // feed the canonical INPUT shape the matcher really sends.
  it("a canonical feature-<slug> id validates → mb-feature-<slug> (no double prefix)", () => {
    const catalog: LabelCatalog = {
      featureIds: new Set(["feature-widget"]),
      flowIds: new Set(),
    };
    const v = buildDesiredLabels(
      { feature: "feature-widget", flows: [], symptom: "crash-error" },
      catalog,
    );
    expect(v.feature).toBe("mb-feature-widget");
    expect(v.feature).not.toContain("feature-feature");
  });

  it("a canonical flow-<slug> id validates → mb-flow-<slug> (no double prefix)", () => {
    const catalog: LabelCatalog = {
      featureIds: new Set(),
      flowIds: new Set(["flow-onboarding"]),
    };
    const v = buildDesiredLabels(
      { flows: ["flow-onboarding"], symptom: "crash-error" },
      catalog,
    );
    expect(v.flows).toEqual(["mb-flow-onboarding"]);
    expect(v.flows.join("")).not.toContain("flow-flow");
  });

  it("a bare name STILL validates → mb-feature-<slug> (legacy contract preserved)", () => {
    const catalog: LabelCatalog = {
      featureIds: new Set(["feature-x"]),
      flowIds: new Set(),
    };
    const v = buildDesiredLabels(
      { feature: "x", flows: [], symptom: "crash-error" },
      catalog,
    );
    expect(v.feature).toBe("mb-feature-x");
  });

  it("a catalog id whose label starts with the kind word resolves for BOTH bare + canonical input", () => {
    // Catalog entry id is `feature-feature-flags` (its label legitimately begins
    // with the kind word). Bare `feature-flags` → prefix once. Canonical
    // `feature-feature-flags` → already a member, used as-is. Both balance.
    const catalog: LabelCatalog = {
      featureIds: new Set(["feature-feature-flags"]),
      flowIds: new Set(),
    };
    const fromBare = buildDesiredLabels(
      { feature: "feature-flags", flows: [], symptom: "crash-error" },
      catalog,
    );
    const fromCanonical = buildDesiredLabels(
      { feature: "feature-feature-flags", flows: [], symptom: "crash-error" },
      catalog,
    );
    expect(fromBare.feature).toBe("mb-feature-feature-flags");
    expect(fromCanonical.feature).toBe("mb-feature-feature-flags");
  });

  it("AC6 — an UNKNOWN id is STILL rejected on BOTH axes (guard not weakened)", () => {
    const catalog: LabelCatalog = {
      featureIds: new Set(["feature-widget"]),
      flowIds: new Set(["flow-onboarding"]),
    };
    // Unknown on the feature axis — neither `nope` nor `feature-nope` is a member.
    expect(() =>
      buildDesiredLabels(
        { feature: "feature-nope", flows: [], symptom: "crash-error" },
        catalog,
        undefined,
        () => {},
      ),
    ).toThrow(LabelValidationError);
    // Unknown on the flow axis — neither `nope` nor `flow-nope` is a member.
    expect(() =>
      buildDesiredLabels(
        { flows: ["flow-nope"], symptom: "crash-error" },
        catalog,
        undefined,
        () => {},
      ),
    ).toThrow(LabelValidationError);
  });
});

describe("AC-6 — label-set PUT body shape (clean issue)", () => {
  it("issues exactly ONE PUT with the expected headers + label-add set", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);
    const target = buildDesiredLabels(
      { feature: "x", flows: ["a", "b"], symptom: "crash-error" },
      membershipFromCatalog({
        features: [{ id: "feature-x" }],
        flows: [{ id: "flow-a" }, { id: "flow-b" }],
      }),
    );

    const didPut = await writer.applyLabels("DEMO-7", [], target);
    expect(didPut).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://example.atlassian.net/rest/api/3/issue/DEMO-7");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Accept).toBe("application/json");

    const ops = JSON.parse(init.body).update.labels as Array<{ add?: string; remove?: string }>;
    const adds = ops.filter((o) => o.add).map((o) => o.add);
    expect(new Set(adds)).toEqual(
      new Set(["mb-feature-x", "mb-flow-a", "mb-flow-b", "mb-symptom-crash-error"]),
    );
  });
});

describe("AC-8 — bot-label JQL is enumerated, sorted, quoted, no wildcard", () => {
  it("emits the exact labels in (...) string for a synthetic catalog", () => {
    const catalog = {
      features: [{ id: "feature-alpha" }, { id: "feature-beta" }],
      flows: [{ id: "flow-gamma" }],
    };
    const jql = buildBotLabelJql(catalog);

    expect(jql).not.toContain("*");

    const expectedLabels = [
      "mb-feature-alpha",
      "mb-feature-beta",
      "mb-flow-gamma",
      ...DEFECT_CATEGORIES.map((c) => `mb-symptom-${c}`),
    ].sort();
    const expected = `labels in (${expectedLabels.map((l) => `"${l}"`).join(",")})`;
    expect(jql).toBe(expected);
  });
});
