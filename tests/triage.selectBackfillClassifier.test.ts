import {
  selectBackfillClassifier,
  type SelectBackfillClassifierOptions,
} from "../src/triage/selectBackfillClassifier";
import { CatalogNotReviewedError } from "../src/catalog/reviewedGate";
import type { JiraIssue } from "../src/jira/sync";

/**
 * #1355 — the DEFAULT no-flag backfill run must cost ZERO real LLM spend, the
 * paid production classifier is an explicit `--real` / `--apply` opt-in, and the
 * catalog-reviewed gate must fire BEFORE the paid classifier is ever built.
 *
 * These prove the cost / gating precedence of the selection seam directly, with
 * ZERO network / model / creds — a synthetic catalog + a `completeFactory` whose
 * inner `complete` calls a `getClient` spy. The spy's call-count is the
 * observable "did we spend?" signal.
 */

/** One synthetic issue — enough to exercise ≥1 classify() call. */
const SYNTH_ISSUE = {
  summary: "synthetic widget fails to load",
  descriptionText: "synthetic body",
} as unknown as JiraIssue;

/** Reviewed synthetic catalog (invented ids — never real product vocabulary). */
const REVIEWED_CATALOG = {
  reviewed: true,
  features: [{ id: "feature-synthetic", label: "Synthetic" }],
  flows: [{ id: "flow-synthetic", label: "Synthetic Flow" }],
};
const UNREVIEWED_CATALOG = { ...REVIEWED_CATALOG, reviewed: false };

/**
 * A completeFactory whose inner `complete` invokes a `getClient` spy — exactly
 * the production lazy-getClient shape. Returns both spies so a test can assert
 * call-counts on the factory (was the paid classifier constructed?) and on
 * getClient (was the Anthropic client ever touched?).
 */
function spyingFactory(reply = '{"feature":null,"flows":[],"confidence":"low"}') {
  const getClient = jest.fn();
  const completeFactory = jest.fn(() => {
    return async (_prompt: string) => {
      getClient();
      return reply;
    };
  });
  return { getClient, completeFactory };
}

function baseOpts(
  over: Partial<SelectBackfillClassifierOptions>,
): SelectBackfillClassifierOptions {
  const { completeFactory } = spyingFactory();
  return {
    apply: false,
    real: false,
    symptomOnly: false,
    catalog: UNREVIEWED_CATALOG,
    completeFactory,
    ...over,
  };
}

describe("#1355 AC1 — zero-spend default", () => {
  it("the no-flag path makes ZERO getClient calls while still classifying ≥1 issue", async () => {
    const { getClient, completeFactory } = spyingFactory();
    const classifier = selectBackfillClassifier(
      baseOpts({ completeFactory, catalog: UNREVIEWED_CATALOG }),
    );

    // Process ≥1 synthetic issue — the null classifier must still run cleanly.
    const result = await classifier.classify(SYNTH_ISSUE);

    expect(result).toEqual({ flows: [] });
    expect(completeFactory).toHaveBeenCalledTimes(0); // paid classifier never built
    expect(getClient).toHaveBeenCalledTimes(0); // Anthropic client never touched → $0
  });
});

describe("#1355 AC2 — fail-closed before any spend (unreviewed catalog)", () => {
  it("--real against reviewed:false throws CatalogNotReviewedError with ZERO getClient calls", () => {
    const { getClient, completeFactory } = spyingFactory();
    expect(() =>
      selectBackfillClassifier(
        baseOpts({ real: true, completeFactory, catalog: UNREVIEWED_CATALOG }),
      ),
    ).toThrow(CatalogNotReviewedError);
    // The throw precedes any client construction OR use.
    expect(completeFactory).toHaveBeenCalledTimes(0);
    expect(getClient).toHaveBeenCalledTimes(0);
  });

  it("--apply against reviewed:false also throws before any getClient call", () => {
    const { getClient, completeFactory } = spyingFactory();
    expect(() =>
      selectBackfillClassifier(
        baseOpts({ apply: true, completeFactory, catalog: UNREVIEWED_CATALOG }),
      ),
    ).toThrow(CatalogNotReviewedError);
    expect(completeFactory).toHaveBeenCalledTimes(0);
    expect(getClient).toHaveBeenCalledTimes(0);
  });
});

describe("#1355 AC3 — real classifier is opt-in only", () => {
  it("poisoned getClient never fires on the default no-flag path", async () => {
    const completeFactory = jest.fn(() => async (_p: string) => {
      throw new Error("POISON: getClient must not be reached on the default path");
    });
    const classifier = selectBackfillClassifier(
      baseOpts({ completeFactory, catalog: UNREVIEWED_CATALOG }),
    );
    // Runs to completion WITHOUT firing the poison.
    await expect(classifier.classify(SYNTH_ISSUE)).resolves.toEqual({ flows: [] });
    expect(completeFactory).not.toHaveBeenCalled();
  });

  it("--real against a REVIEWED catalog DOES reach the production wrapper", async () => {
    const completeFactory = jest.fn(() => async (_p: string) => {
      throw new Error("POISON: production complete invoked");
    });
    const classifier = selectBackfillClassifier(
      baseOpts({ real: true, completeFactory, catalog: REVIEWED_CATALOG }),
    );
    // The paid classifier was constructed (factory invoked once)...
    expect(completeFactory).toHaveBeenCalledTimes(1);
    // ...and classifying actually drives the production complete (poison fires).
    await expect(classifier.classify(SYNTH_ISSUE)).rejects.toThrow(/POISON/);
  });

  it("--symptom-only forces the free null classifier even under --real", async () => {
    const { getClient, completeFactory } = spyingFactory();
    const classifier = selectBackfillClassifier(
      baseOpts({
        real: true,
        symptomOnly: true,
        completeFactory,
        catalog: REVIEWED_CATALOG,
      }),
    );
    await expect(classifier.classify(SYNTH_ISSUE)).resolves.toEqual({ flows: [] });
    expect(completeFactory).toHaveBeenCalledTimes(0);
    expect(getClient).toHaveBeenCalledTimes(0);
  });
});
