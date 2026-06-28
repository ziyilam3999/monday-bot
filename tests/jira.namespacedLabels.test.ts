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
