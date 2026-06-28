import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { distillCatalog } from "../src/catalog/distill";
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
