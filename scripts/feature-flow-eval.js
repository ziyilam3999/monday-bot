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
 *     node --env-file=.env scripts/feature-flow-eval.js --real [--limit N]
 *     Constructs the REAL getClient() + production model (only inside this
 *     branch) and runs the matcher against real open-defect text, printing a
 *     total token + USD cost projection. COST-INCURRING — operator go only.
 *     `--limit N` (#3136) runs only the FIRST N defects in the fetcher's
 *     stable order (fixed sample for A/B arms); default is all open defects.
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
const { resolveModel, pricingForModel, CLASSIFIER_EFFORT } = require(path.join(DIST, "llm", "modelConfig"));
const { warnMaxTokensStop } = require(path.join(DIST, "llm", "anthropicClient"));

/** Gitignored catalog path (mirrors backfill-namespaced-labels.js). */
const CATALOG_OUTPUT_PATH = path.resolve(
  __dirname,
  "..",
  ".ai-workspace",
  "catalog",
  "feature-catalog.json",
);

/** Rate card comes from dist/llm/modelConfig (one source of truth, #3136) and
 * is selected per REQUESTED model id, so override / A-B arms price their own
 * runs (5.5 card 0.10/0.50; legacy 4.x override arms 1.0/5.0). */
/** Per-defect token budget (upper-typical) for the cost projection. This is a
 * 4.5-era PROJECTION number: the Haiku 5.5 tokenizer counts ~30% more tokens
 * for the same text, so it under-counts — the measured usage totals printed
 * alongside supersede it (#3136). */
const PER_DEFECT_INPUT_TOKENS = 2050;
const PER_DEFECT_OUTPUT_TOKENS = 50;

/** Gitignored per-defect capture dir for A/B comparison (never printed). */
const CAPTURE_DIR = path.resolve(__dirname, "..", ".ai-workspace", "eval-captures");

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
function buildProductionComplete(usage) {
  const { getClient } = require(path.join(DIST, "llm", "anthropicClient"));
  const model = resolveModel();
  return async function complete(prompt) {
    const client = getClient();
    const res = await client.messages.create({
      model,
      // 2048: medium effort thinks ~500+ tokens BEFORE the text block; 256 truncated (plan risk 5 remedy)
      max_tokens: 2048,
      output_config: { effort: CLASSIFIER_EFFORT },
      messages: [{ role: "user", content: prompt }],
    });
    warnMaxTokensStop(res, "feature-flow-eval.complete");
    if (usage && res.usage) {
      usage.inputTokens += res.usage.input_tokens || 0;
      usage.outputTokens += res.usage.output_tokens || 0;
    }
    return Array.isArray(res.content)
      ? res.content
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("")
      : "";
  };
}

/** Parse `--limit N` (positive integer) from argv; undefined = unlimited. */
function parseLimit(argv) {
  const i = argv.indexOf("--limit");
  if (i === -1) return undefined;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`feature-flow-eval --real: --limit must be a positive integer (got ${argv[i + 1]})`);
    process.exit(1);
  }
  return n;
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
  let issues = await fetcher.fetchOpenDefects(projects[0]);
  // #3136 sample control: --limit N runs the FIRST N defects in the fetcher's
  // stable order (fixed sample for A/B arms); default stays unlimited.
  const limit = parseLimit(process.argv);
  if (limit !== undefined) issues = issues.slice(0, limit);

  // The real model boundary is constructed ONLY here, inside the --real branch.
  const usage = { inputTokens: 0, outputTokens: 0 };
  const complete = buildProductionComplete(usage);
  const menuCatalog = { features: catalog.features, flows: catalog.flows };
  const model = resolveModel();

  let confident = 0;
  let none = 0;
  const perDefect = [];
  for (const issue of issues) {
    const predicted = await matchFeatureFlow(menuCatalog, complete, {
      summary: issue.summary,
      descriptionText: issue.descriptionText,
    });
    if (predicted.feature !== undefined) confident++;
    else none++;
    perDefect.push({
      key: issue.key,
      confident: predicted.feature !== undefined,
      feature: predicted.feature ?? null,
      flows: predicted.flows,
    });
  }

  // Per-defect capture (issue key -> confident/none + chosen ids) for the A/B
  // paired split (#3136): gitignored path, NEVER printed — only the path is logged.
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const capturePath = path.join(
    CAPTURE_DIR,
    `${model.replace(/[^a-z0-9.-]/gi, "_")}-${stamp}.json`,
  );
  fs.writeFileSync(capturePath, JSON.stringify(perDefect, null, 2));

  const cost = estimateCost(
    PER_DEFECT_INPUT_TOKENS,
    PER_DEFECT_OUTPUT_TOKENS,
    issues.length,
    pricingForModel(model),
  );
  // Counts / projection ONLY — never defect text, labels, or catalog vocabulary.
  console.log(
    `feature-flow-eval (real): model=${model} total=${issues.length} confident=${confident} none=${none} ` +
      `est-input-tokens=${cost.totalInputTokens} est-output-tokens=${cost.totalOutputTokens} ` +
      `est-usd=${cost.estimatedUsd.toFixed(2)}`,
  );
  // Measured usage totals (#3136) + the gitignored capture path (path only).
  console.log(
    `usage: model=${model} measured-input-tokens=${usage.inputTokens} ` +
      `measured-output-tokens=${usage.outputTokens} capture=${capturePath}`,
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
