import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { distillCatalog, PER_PAGE_OVERHEAD_CHARS } from "../src/catalog/distill";
import {
  run,
  chooseWritePath,
  CATALOG_OUTPUT_PATH,
  CATALOG_REGENERATED_PATH,
} from "../src/catalog/cli";
import type { CatalogDistiller, CatalogPage, FeatureCatalog } from "../src/catalog/types";

/**
 * #1314 S2 — Confluence feature/flow catalog tooling.
 *
 * SYNTHETIC fixtures ONLY (DEMO space, example.atlassian.net, invented
 * titles/ids/labels). ZERO network, ZERO real LLM — both seams are injected.
 */

const PAGES: CatalogPage[] = [
  { id: "p1", title: "Demo Page One", body: "Visitors can sign in to the demo workspace." },
  { id: "p2", title: "Demo Page Two", body: "A shopper completes purchase at checkout." },
  { id: "p3", title: "Demo Page Three", body: "Operators read summary dashboards." },
];

/** Canned distiller — 2 features, 1 flow, all provenance within the corpus. */
const stubDistiller: CatalogDistiller = {
  async distill() {
    return {
      features: [
        { label: "Sign In", provenancePageIds: ["p1"] },
        { label: "Reporting Dashboard", provenancePageIds: ["p3"] },
      ],
      flows: [{ label: "Checkout Flow", provenancePageIds: ["p2"] }],
    };
  },
};

const FROZEN_NOW = () => 0;

describe("AC-DISTILL — distillCatalog over a synthetic >=3-page corpus", () => {
  it("returns the expected feature/flow counts with valid, non-empty entries", async () => {
    const catalog = await distillCatalog(PAGES, { distiller: stubDistiller, now: FROZEN_NOW });
    expect(catalog.features).toHaveLength(2);
    expect(catalog.flows).toHaveLength(1);

    const corpusIds = new Set(PAGES.map((p) => p.id));
    for (const entry of [...catalog.features, ...catalog.flows]) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.provenancePageIds.length).toBeGreaterThan(0);
      for (const pid of entry.provenancePageIds) {
        expect(corpusIds.has(pid)).toBe(true);
      }
    }
    // reviewed defaults false (human-review loop preserved).
    expect(catalog.reviewed).toBe(false);
  });
});

describe("AC-STABLEID — re-running yields identical ids", () => {
  it("produces byte-identical entry arrays across two runs of the same input", async () => {
    const r1 = await distillCatalog(PAGES, { distiller: stubDistiller, now: FROZEN_NOW });
    const r2 = await distillCatalog(PAGES, { distiller: stubDistiller, now: FROZEN_NOW });
    expect(JSON.stringify(r1.features)).toBe(JSON.stringify(r2.features));
    expect(JSON.stringify(r1.flows)).toBe(JSON.stringify(r2.flows));
    // Spot-check a concrete stable id (deterministic slug).
    expect(r1.features.map((f) => f.id)).toContain("feature-sign-in");
    expect(r1.flows.map((f) => f.id)).toContain("flow-checkout-flow");
  });
});

describe("AC-PROVENANCE-PRUNE — stray provenance ids dropped, empty entries removed", () => {
  it("keeps only corpus ids and removes a zero-valid-provenance entry", async () => {
    const distiller: CatalogDistiller = {
      async distill() {
        return {
          features: [
            // one bogus + one real id -> bogus pruned, entry kept
            { label: "Mixed Provenance", provenancePageIds: ["BOGUS", "p1"] },
            // only bogus -> entry removed entirely
            { label: "All Bogus", provenancePageIds: ["NOPE"] },
          ],
          flows: [],
        };
      },
    };
    const catalog = await distillCatalog(PAGES, { distiller, now: FROZEN_NOW });
    expect(catalog.features).toHaveLength(1);
    expect(catalog.features[0].label).toBe("Mixed Provenance");
    expect(catalog.features[0].provenancePageIds).toEqual(["p1"]);
  });
});

describe("dedup — entries that slug to the same id merge, unioning provenance", () => {
  it("collapses same-slug labels into one entry", async () => {
    const distiller: CatalogDistiller = {
      async distill() {
        return {
          features: [
            { label: "Sign In", provenancePageIds: ["p1"] },
            { label: "sign-in", provenancePageIds: ["p3"] }, // same slug
          ],
          flows: [],
        };
      },
    };
    const catalog = await distillCatalog(PAGES, { distiller, now: FROZEN_NOW });
    expect(catalog.features).toHaveLength(1);
    expect(catalog.features[0].id).toBe("feature-sign-in");
    expect(catalog.features[0].provenancePageIds).toEqual(["p1", "p3"]);
  });
});

describe("AC-SLUG-FALLBACK — a single empty-normalizing label stays addressable (#1328 Surface 2)", () => {
  it("yields exactly one entry with the feature-entry sentinel id", async () => {
    const distiller: CatalogDistiller = {
      async distill() {
        return {
          // "!@#$" normalizes (via the shared slug()) to the empty string.
          features: [{ label: "!@#$", provenancePageIds: ["p1"] }],
          flows: [],
        };
      },
    };
    const catalog = await distillCatalog(PAGES, { distiller, now: FROZEN_NOW });
    expect(catalog.features).toHaveLength(1);
    expect(catalog.features[0].id).toBe("feature-entry");
    expect(catalog.features[0].provenancePageIds).toEqual(["p1"]);
  });
});

describe("AC-SLUG-COLLISION-DETECTABLE — distinct empty-normalizing labels stay distinct (#1328 Surface 2)", () => {
  it("two different junk labels produce two detectable entries, not one silent merge", async () => {
    const distiller: CatalogDistiller = {
      async distill() {
        return {
          features: [
            { label: "!@#$", provenancePageIds: ["p1"] },
            { label: "🚀", provenancePageIds: ["p3"] }, // emoji-only, also empty-normalizes
          ],
          flows: [],
        };
      },
    };
    const catalog = await distillCatalog(PAGES, { distiller, now: FROZEN_NOW });
    // Both survive as distinct entries (NOT one merged feature-entry).
    expect(catalog.features).toHaveLength(2);
    const ids = catalog.features.map((f) => f.id);
    expect(ids).toContain("feature-entry");
    expect(ids).toContain("feature-entry-2");
    // Provenance is NOT unioned across the two distinct labels.
    const byId = new Map(catalog.features.map((f) => [f.id, f]));
    expect(byId.get("feature-entry")!.provenancePageIds).toEqual(["p1"]);
    expect(byId.get("feature-entry-2")!.provenancePageIds).toEqual(["p3"]);
    // Both original labels are preserved (provenance/detectability kept).
    const labels = catalog.features.map((f) => f.label).sort();
    expect(labels).toEqual(["!@#$", "🚀"]);
  });
});

describe("AC-SLUG-EMPTY-NORMALIZE-EDGES — a batch of empty-normalizing labels all stay detectable (#1328 Surface 2)", () => {
  it("symbols / emoji / whitespace / very-long all-symbol inputs each get a distinct id, deterministically", async () => {
    const longSymbols = "#".repeat(200);
    const distiller: CatalogDistiller = {
      async distill() {
        return {
          features: [
            { label: "!@#$", provenancePageIds: ["p1"] }, // symbols-only
            { label: "🚀🚀", provenancePageIds: ["p2"] }, // emoji-only
            { label: "   ", provenancePageIds: ["p3"] }, // whitespace-only
            { label: longSymbols, provenancePageIds: ["p1"] }, // very-long all-symbol
          ],
          flows: [],
        };
      },
    };
    const r1 = await distillCatalog(PAGES, { distiller, now: FROZEN_NOW });
    // Four distinct empty-normalizing labels -> four distinct, detectable ids.
    expect(r1.features).toHaveLength(4);
    const ids = r1.features.map((f) => f.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) {
      expect(id.startsWith("feature-entry")).toBe(true);
    }
    // Deterministic across re-runs (AC-STABLEID preserved on the fallback path).
    const r2 = await distillCatalog(PAGES, { distiller, now: FROZEN_NOW });
    expect(JSON.stringify(r2.features)).toBe(JSON.stringify(r1.features));
  });

  it("an identical empty-normalizing label appearing twice still merges with itself", async () => {
    const distiller: CatalogDistiller = {
      async distill() {
        return {
          features: [
            { label: "!@#$", provenancePageIds: ["p1"] },
            { label: "!@#$", provenancePageIds: ["p3"] }, // same junk label -> one entry
          ],
          flows: [],
        };
      },
    };
    const catalog = await distillCatalog(PAGES, { distiller, now: FROZEN_NOW });
    expect(catalog.features).toHaveLength(1);
    expect(catalog.features[0].id).toBe("feature-entry");
    expect(catalog.features[0].provenancePageIds).toEqual(["p1", "p3"]);
  });
});

describe("AC-NO-NETWORK — zero global fetch across the full run() orchestration (N2)", () => {
  it("never touches globalThis.fetch after the whole run(deps) CLI smoke", async () => {
    const fetchSpy = jest.fn();
    const original = globalThis.fetch;
    // Install a spy in place of the real fetch for the duration of the run.
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const captured: FeatureCatalog[] = [];
      await run({
        fetchPages: async () => PAGES,
        distiller: stubDistiller,
        writeCatalog: async (c) => {
          captured.push(c);
        },
        spaceKey: "DEMO",
        now: FROZEN_NOW,
        log: () => undefined,
      });
      // N2: assert AFTER the full orchestration path, not just the unit.
      expect(fetchSpy).toHaveBeenCalledTimes(0);
      expect(captured).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("AC-LEAK — internal names go ONLY to the sink, never to stdout", () => {
  it("keeps the sentinel out of every log line but present in the written catalog", async () => {
    const SENTINEL = "ZZSECRETFEATURE";
    const SECRET_BODY = "internal-only body about ZZSECRETFEATURE handling";
    const leakyPages: CatalogPage[] = [
      { id: "p1", title: "Demo Page One", body: SECRET_BODY },
      { id: "p2", title: "Demo Page Two", body: "ordinary synthetic prose" },
    ];
    const leakyDistiller: CatalogDistiller = {
      async distill() {
        return {
          features: [{ label: SENTINEL, provenancePageIds: ["p1"] }],
          flows: [{ label: "Checkout Flow", provenancePageIds: ["p2"] }],
        };
      },
    };

    const logs: string[] = [];
    const captured: FeatureCatalog[] = [];
    const result = await run({
      fetchPages: async () => leakyPages,
      distiller: leakyDistiller,
      writeCatalog: async (c) => {
        captured.push(c);
      },
      spaceKey: "DEMO",
      now: FROZEN_NOW,
      log: (m) => logs.push(m),
    });

    const stdout = logs.join("\n");
    // stdout carries counts/structure only — no label, no page body.
    expect(stdout).not.toContain(SENTINEL);
    expect(stdout).not.toContain(SECRET_BODY);
    expect(stdout).not.toContain("p1");
    // ...but the counts ARE present.
    expect(stdout).toContain("1 features, 1 flows");
    expect(result.featureCount).toBe(1);

    // The gitignored sink DOES hold the internal label.
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured[0])).toContain(SENTINEL);
  });
});

describe("AC-GITIGNORED — the tool's real output path is gitignored (N1)", () => {
  it("git check-ignore exits 0 for the shell's CATALOG_OUTPUT_PATH constant", () => {
    // N1: assert against the SAME constant the shell writes to, not a literal.
    expect(() =>
      execFileSync("git", ["check-ignore", CATALOG_OUTPUT_PATH], {
        cwd: process.cwd(),
        stdio: "pipe",
      }),
    ).not.toThrow();
    expect(() =>
      execFileSync("git", ["check-ignore", CATALOG_REGENERATED_PATH], {
        cwd: process.cwd(),
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});

describe("AC-SCHEMA — the written catalog matches the FeatureCatalog contract", () => {
  it("passes a well-formed FeatureCatalog object to writeCatalog", async () => {
    const captured: FeatureCatalog[] = [];
    await run({
      fetchPages: async () => PAGES,
      distiller: stubDistiller,
      writeCatalog: async (c) => {
        captured.push(c);
      },
      spaceKey: "DEMO",
      now: FROZEN_NOW,
      log: () => undefined,
    });
    expect(captured).toHaveLength(1);
    const catalog = captured[0];
    expect(typeof catalog.generatedAt).toBe("string");
    expect(catalog.reviewed).toBe(false);
    expect(Array.isArray(catalog.features)).toBe(true);
    expect(Array.isArray(catalog.flows)).toBe(true);
    for (const entry of [...catalog.features, ...catalog.flows]) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(Array.isArray(entry.provenancePageIds)).toBe(true);
      expect(entry.provenancePageIds.every((p) => typeof p === "string")).toBe(true);
    }
  });
});

describe("AC-REUSE-FETCHER — reuses src/confluence/sync, no re-implemented pagination", () => {
  it("the shell wires the real confluence/sync fetcher", () => {
    const shell = readFileSync(join(__dirname, "..", "scripts", "build-catalog.js"), "utf-8");
    expect(shell).toContain("confluence/sync");
  });

  it("no catalog source re-implements pagination/endpoints", () => {
    const dir = join(__dirname, "..", "src", "catalog");
    const offenders = /(_links\.next|wiki\/rest\/api\/content)/;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, file), "utf-8");
      expect(offenders.test(src)).toBe(false);
    }
  });
});

describe("AC-BATCH-MULTI — a multi-batch corpus drives >1 distiller call; merge dedups + unions provenance", () => {
  it("calls the fake per batch and unions same-slug provenance across batches", async () => {
    // Tiny budget + charsPerToken=1 so each synthetic page lands in its OWN batch.
    const SPLIT_PAGES: CatalogPage[] = [
      { id: "p1", title: "T1", body: "alpha body one" },
      { id: "p2", title: "T2", body: "beta body two" },
      { id: "p3", title: "T3", body: "gamma body three" },
    ];
    let calls = 0;
    // ARGUMENT-AWARE: provenance + the per-batch-unique label are derived from
    // the pages each call actually receives (a vacuous arg-ignoring fake would
    // make the merge assertion meaningless).
    const distiller: CatalogDistiller = {
      async distill(pages) {
        calls += 1;
        const ids = pages.map((p) => p.id);
        return {
          features: [
            // Same slug in EVERY batch -> must merge to one entry, provenance unioned.
            { label: "Shared Feature", provenancePageIds: ids },
            // Distinct per batch -> proves the calls really saw different pages.
            { label: `Unique ${ids.join("-")}`, provenancePageIds: ids },
          ],
          flows: [],
        };
      },
    };

    const catalog = await distillCatalog(SPLIT_PAGES, {
      distiller,
      now: FROZEN_NOW,
      batchTokenBudget: 60,
      charsPerToken: 1,
    });

    // >1 batch -> >1 fake-distiller call.
    expect(calls).toBeGreaterThan(1);

    const shared = catalog.features.find((f) => f.id === "feature-shared-feature");
    expect(shared).toBeDefined();
    // Provenance is the insertion-ordered UNION across all batches.
    expect(shared!.provenancePageIds).toEqual(["p1", "p2", "p3"]);

    // Per-batch-unique features survived distinctly (one per batch).
    expect(catalog.features.filter((f) => f.id.startsWith("feature-unique"))).toHaveLength(3);

    // Every provenance id stays within the corpus.
    const corpusIds = new Set(SPLIT_PAGES.map((p) => p.id));
    for (const entry of [...catalog.features, ...catalog.flows]) {
      for (const pid of entry.provenancePageIds) {
        expect(corpusIds.has(pid)).toBe(true);
      }
    }
  });
});

describe("AC-BATCH-CONFLICT — same id across batches: first-wins label + unioned provenance", () => {
  it("keeps the first-seen label and unions provenance on a real slug collision", async () => {
    const CONFLICT_PAGES: CatalogPage[] = [
      { id: "p1", title: "T1", body: "first batch body content" },
      { id: "p2", title: "T2", body: "second batch body content" },
    ];
    // ARGUMENT-AWARE: returns a DIFFERENT label per batch keyed on the pages it
    // receives. "Sign In" (p1's batch) and "sign-in" (p2's batch) both slug to
    // "sign-in" -> a genuine same-id-across-batches conflict.
    const distiller: CatalogDistiller = {
      async distill(pages) {
        const ids = pages.map((p) => p.id);
        if (ids.includes("p1")) {
          return { features: [{ label: "Sign In", provenancePageIds: ["p1"] }], flows: [] };
        }
        if (ids.includes("p2")) {
          return { features: [{ label: "sign-in", provenancePageIds: ["p2"] }], flows: [] };
        }
        return { features: [], flows: [] };
      },
    };

    const catalog = await distillCatalog(CONFLICT_PAGES, {
      distiller,
      now: FROZEN_NOW,
      batchTokenBudget: 60,
      charsPerToken: 1,
    });

    // Exactly one merged entry; FIRST-seen label (batch order = page order) wins.
    expect(catalog.features).toHaveLength(1);
    expect(catalog.features[0].id).toBe("feature-sign-in");
    expect(catalog.features[0].label).toBe("Sign In");
    expect(catalog.features[0].provenancePageIds).toEqual(["p1", "p2"]);
  });
});

describe("AC-BATCH-OVERSIZED — a single over-budget page is TRUNCATED (not dropped) + warning logged", () => {
  it("truncates the body on a copy, logs a counts-only warning, keeps the entry", async () => {
    const budget = 100;
    const charsPerToken = 1;
    const TITLE = "ZBIGTITLE";
    const BODY_MARKER = "ZBODYSECRET";
    const oversizedBody = `${BODY_MARKER}${"x".repeat(500)}`;
    const OVERSIZED_PAGES: CatalogPage[] = [{ id: "p1", title: TITLE, body: oversizedBody }];

    const received: Array<{ id: string; title: string; body: string }> = [];
    const distiller: CatalogDistiller = {
      async distill(pages) {
        received.push(...pages.map((p) => ({ id: p.id, title: p.title, body: p.body })));
        return {
          features: [{ label: "Oversized Feature", provenancePageIds: pages.map((p) => p.id) }],
          flows: [],
        };
      },
    };

    const logs: string[] = [];
    const catalog = await distillCatalog(OVERSIZED_PAGES, {
      distiller,
      now: FROZEN_NOW,
      batchTokenBudget: budget,
      charsPerToken,
      log: (m) => logs.push(m),
    });

    // The page still PARTICIPATED (its id reached the distiller) — never dropped.
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe("p1");

    // The body was truncated to the budget-DERIVED cap (a copy — input untouched).
    const cap = budget * charsPerToken - PER_PAGE_OVERHEAD_CHARS - "p1".length - TITLE.length;
    expect(received[0].body.length).toBeLessThanOrEqual(cap);
    expect(received[0].body.length).toBeLessThan(oversizedBody.length);
    // Input page was NOT mutated.
    expect(OVERSIZED_PAGES[0].body).toBe(oversizedBody);

    // The catalog still contains the entry, with that page's id in provenance.
    const entry = catalog.features.find((f) => f.provenancePageIds.includes("p1"));
    expect(entry).toBeDefined();

    // A LOUD truncation warning was logged.
    const stdout = logs.join("\n");
    expect(stdout).toMatch(/WARN/);
    expect(stdout).toMatch(/truncated/);
    // The warning carries NO label / title / body / id — counts/structure only.
    expect(stdout).not.toContain(TITLE);
    expect(stdout).not.toContain(BODY_MARKER);
    expect(stdout).not.toContain("p1");
    expect(stdout).not.toContain("Oversized Feature");
  });
});

describe("AC-BATCH-SINGLE-UNCHANGED — a sub-budget corpus stays single-batch (one call)", () => {
  it("makes exactly one distiller call and the same counts/ids as today", async () => {
    let calls = 0;
    const counting: CatalogDistiller = {
      async distill() {
        calls += 1;
        return {
          features: [
            { label: "Sign In", provenancePageIds: ["p1"] },
            { label: "Reporting Dashboard", provenancePageIds: ["p3"] },
          ],
          flows: [{ label: "Checkout Flow", provenancePageIds: ["p2"] }],
        };
      },
    };
    // DEFAULT budget (no override) -> the 3-page PAGES fixture stays one batch.
    const catalog = await distillCatalog(PAGES, { distiller: counting, now: FROZEN_NOW });
    expect(calls).toBe(1);
    expect(catalog.features).toHaveLength(2);
    expect(catalog.flows).toHaveLength(1);
    expect(catalog.features.map((f) => f.id)).toContain("feature-sign-in");
    expect(catalog.flows.map((f) => f.id)).toContain("flow-checkout-flow");
  });
});

describe("no-clobber guard — chooseWritePath", () => {
  it("writes the primary path when it does not exist, the sibling when it does", () => {
    expect(chooseWritePath(CATALOG_OUTPUT_PATH, CATALOG_REGENERATED_PATH, () => false)).toBe(
      CATALOG_OUTPUT_PATH,
    );
    expect(chooseWritePath(CATALOG_OUTPUT_PATH, CATALOG_REGENERATED_PATH, () => true)).toBe(
      CATALOG_REGENERATED_PATH,
    );
  });
});
