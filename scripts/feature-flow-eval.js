#!/usr/bin/env node
/*
 * feature-flow-eval.js — thin I/O shell over the injectable feature/flow matcher
 * core (`dist/triage/featureFlowMatcher.js`) + the pure scoring/cost math
 * (`dist/triage/featureFlowEval.js`). Mirrors the dry-run-by-default eval pattern
 * of eval-golden.js (#1170) and build-catalog.js (#1314).
 *
 * TWO clearly-separated modes:
 *
 *   Mode 1 — synthetic accuracy (DEFAULT, ZERO cost, build-time):
 *     node scripts/feature-flow-eval.js
 *     Runs the matcher against a baked SYNTHETIC labeled sample with a FAKE
 *     `complete` (canned JSON). ZERO network / model / creds. Reports per-axis
 *     accuracy + confident/none counts. Counts/structure ONLY.
 *
 *   Mode 2 — REAL accuracy + cost projection (GATED — Gate A, NOT run at build):
 *     node --env-file=.env scripts/feature-flow-eval.js --real
 *     Constructs the REAL getClient() + production model (only inside this
 *     branch) and runs the matcher against real open-defect text, printing a
 *     total token + USD cost projection. COST-INCURRING — operator go only.
 *
 * SAFETY (nit 3): the --real mode REFUSES to run unless the loaded catalog's
 * `reviewed` flag is set — an unreviewed (auto-distilled, unverified) menu must
 * never drive a cost-incurring eval. Fails closed with a clear message.
 *
 * Privacy (PUBLIC repo): the catalog (internal product names) is read from the
 * GITIGNORED output path and NEVER printed; logs are COUNTS/STRUCTURE only —
 * never defect text, label values, or catalog vocabulary. Creds come from env.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DIST = path.resolve(__dirname, "..", "dist");
const { matchFeatureFlow } = require(path.join(DIST, "triage", "featureFlowMatcher"));
const { scoreEval, estimateCost } = require(path.join(DIST, "triage", "featureFlowEval"));
const { assertCatalogReviewed } = require(path.join(DIST, "catalog", "reviewedGate"));

/** Gitignored catalog path (mirrors backfill-namespaced-labels.js). */
const CATALOG_OUTPUT_PATH = path.resolve(
  __dirname,
  "..",
  ".ai-workspace",
  "catalog",
  "feature-catalog.json",
);

/** Claude Haiku 4.5 per-MTok pricing (input / output), no-cache upper bound. */
const PRICING = { inputPerMTok: 1.0, outputPerMTok: 5.0 };
/** Per-defect token budget (upper-typical) for the cost projection. */
const PER_DEFECT_INPUT_TOKENS = 2050;
const PER_DEFECT_OUTPUT_TOKENS = 50;

function splitList(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toSiteRoot(url) {
  return url.replace(/\/wiki\/?$/, "").replace(/\/$/, "");
}

/** Read the gitignored catalog (preserving `reviewed` for the safety gate). */
function loadCatalog() {
  const raw = JSON.parse(fs.readFileSync(CATALOG_OUTPUT_PATH, "utf8"));
  return {
    reviewed: raw.reviewed === true,
    features: Array.isArray(raw.features) ? raw.features : [],
    flows: Array.isArray(raw.flows) ? raw.flows : [],
  };
}

/**
 * Build the PRODUCTION `complete(prompt) → text` wrapper. This is NEW (#1343):
 * there is no pre-existing `complete()` helper — it is a thin wrapper over the
 * existing `getClient()` (`src/llm/anthropicClient.ts`), mirroring
 * build-catalog.js's `buildLlmDistiller`. Constructed ONLY in the --real branch.
 */
function buildProductionComplete() {
  const { getClient } = require(path.join(DIST, "llm", "anthropicClient"));
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  return async function complete(prompt) {
    const client = getClient();
    const res = await client.messages.create({
      model,
      max_tokens: 256,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
    return Array.isArray(res.content)
      ? res.content
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("")
      : "";
  };
}

// ── Mode 1: baked SYNTHETIC sample (invented ids; ZERO cost) ─────────────────
const SYNTHETIC_CATALOG = {
  reviewed: true,
  features: [
    { id: "feature-checkout", label: "Checkout" },
    { id: "feature-search", label: "Search" },
  ],
  flows: [
    { id: "flow-signup", label: "Sign up" },
    { id: "flow-payment", label: "Payment" },
  ],
};
/** Labeled synthetic rows + the canned JSON the fake `complete` returns. */
const SYNTHETIC_SAMPLE = [
  {
    issue: { summary: "card declined at checkout", descriptionText: "" },
    expectedFeature: "feature-checkout",
    expectedFlows: ["flow-payment"],
    canned: '{"feature":"feature-checkout","flows":["flow-payment"],"confidence":"high"}',
  },
  {
    issue: { summary: "no results when searching", descriptionText: "" },
    expectedFeature: "feature-search",
    expectedFlows: [],
    canned: '{"feature":"feature-search","flows":[],"confidence":"high"}',
  },
  {
    issue: { summary: "vague unplaceable report", descriptionText: "" },
    expectedFeature: undefined,
    expectedFlows: [],
    canned: '{"feature":null,"flows":[],"confidence":"low"}',
  },
];

async function runSyntheticMode() {
  const rows = [];
  for (const s of SYNTHETIC_SAMPLE) {
    const fakeComplete = async () => s.canned;
    const predicted = await matchFeatureFlow(SYNTHETIC_CATALOG, fakeComplete, s.issue);
    rows.push({
      expectedFeature: s.expectedFeature,
      expectedFlows: s.expectedFlows,
      predictedFeature: predicted.feature,
      predictedFlows: predicted.flows,
    });
  }
  const score = scoreEval(rows);
  // Counts / rates ONLY — never defect text, labels, or catalog vocabulary.
  console.log(
    `feature-flow-eval (synthetic): total=${score.total} ` +
      `feature-accuracy=${score.featureAccuracy.toFixed(3)} ` +
      `flow-precision=${score.flowPrecision.toFixed(3)} ` +
      `flow-recall=${score.flowRecall.toFixed(3)} ` +
      `confident=${score.confident} none=${score.none}`,
  );
  console.log(
    "\n(synthetic dry-run: ZERO model calls, ZERO cost. Re-run with --real for a " +
      "cost-incurring accuracy + cost projection against real defect text — Gate A.)",
  );
}

async function runRealMode() {
  const catalog = loadCatalog();
  // SAFETY GATE (nit 3): refuse the cost-incurring real run on an unreviewed catalog.
  assertCatalogReviewed(catalog, "feature-flow-eval --real");

  const env = process.env;
  const url = env.CONFLUENCE_URL || env.CONFLUENCE_BASE_URL;
  const email = env.CONFLUENCE_EMAIL;
  const apiToken = env.CONFLUENCE_API_TOKEN;
  const projects = splitList(env.JIRA_PROJECTS);
  if (!url || !email || !apiToken || projects.length === 0) {
    console.error(
      "feature-flow-eval --real: missing config. Need CONFLUENCE_URL (or " +
        "CONFLUENCE_BASE_URL), CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, and a " +
        "non-empty JIRA_PROJECTS.",
    );
    process.exit(1);
  }

  const { buildOpenDefectsFetcher } = require(path.join(DIST, "jira", "sync"));
  const config = { baseUrl: toSiteRoot(url), email, apiToken };
  const scope = {
    statusJql: env.JIRA_OPEN_DEFECTS_STATUS_JQL,
    issueTypeJql: env.JIRA_DEFECT_ISSUETYPE_JQL,
  };
  const fetcher = buildOpenDefectsFetcher(config, scope, globalThis.fetch);
  const issues = await fetcher.fetchOpenDefects(projects[0]);

  // The real model boundary is constructed ONLY here, inside the --real branch.
  const complete = buildProductionComplete();
  const menuCatalog = { features: catalog.features, flows: catalog.flows };

  let confident = 0;
  let none = 0;
  for (const issue of issues) {
    const predicted = await matchFeatureFlow(menuCatalog, complete, {
      summary: issue.summary,
      descriptionText: issue.descriptionText,
    });
    if (predicted.feature !== undefined) confident++;
    else none++;
  }

  const cost = estimateCost(
    PER_DEFECT_INPUT_TOKENS,
    PER_DEFECT_OUTPUT_TOKENS,
    issues.length,
    PRICING,
  );
  // Counts / projection ONLY — never defect text, labels, or catalog vocabulary.
  console.log(
    `feature-flow-eval (real): total=${issues.length} confident=${confident} none=${none} ` +
      `est-input-tokens=${cost.totalInputTokens} est-output-tokens=${cost.totalOutputTokens} ` +
      `est-usd=${cost.estimatedUsd.toFixed(2)}`,
  );
}

async function main() {
  const real = process.argv.includes("--real");
  if (real) {
    await runRealMode();
  } else {
    await runSyntheticMode();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
