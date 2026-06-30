#!/usr/bin/env node
/*
 * backfill-namespaced-labels.js — thin I/O shell over the injectable backfill
 * core (`dist/triage/backfill.js` -> run(deps)).
 *
 * One-time backfill: stamps the bot's `mb-feature-*` / `mb-flow-*` /
 * `mb-symptom-*` labels onto every currently-OPEN Jira defect. Idempotent — a
 * re-run over already-correct issues computes an empty diff and issues ZERO
 * PUTs.
 *
 * DRY-RUN by DEFAULT: classifies + validates + previews, writes NOTHING. The
 * real write-back is reachable ONLY behind an explicit `--apply` flag (operator
 * go) — the only path that constructs the writer and mutates Jira.
 *
 * `--print-jql` prints the enumerated `labels in (...)` clause (no wildcard) for
 * the operator to paste into a saved filter / board swimlanes, then exits.
 *
 * All creds + target come from env ONLY (gitignored .env; repo is PUBLIC). The
 * catalog (internal product names) is read from the GITIGNORED output path and
 * NEVER printed/committed; logs are COUNTS/STRUCTURE only.
 *
 *   Print filter:  node scripts/backfill-namespaced-labels.js --print-jql
 *   Preview (free):node scripts/backfill-namespaced-labels.js            (dry-run, symptom-only, ZERO cost)
 *   Preview (paid):node scripts/backfill-namespaced-labels.js --real     (dry-run, real classifier — gated, no write)
 *   Apply it:      node scripts/backfill-namespaced-labels.js --apply    (outward write — gated)
 *
 * UNSTAMP (reverse — REMOVE all the bot's labels, #1342). DRY-RUN by default;
 * `--apply` is the ONLY mutating path; `--keys K1,K2` scopes to those issues
 * (a typo'd/wrong-case/closed key FAILS LOUD, non-zero exit — never a silent
 * zero-touch "success"):
 *   Preview removes: node scripts/backfill-namespaced-labels.js --unstamp
 *   Remove (scoped): node scripts/backfill-namespaced-labels.js --unstamp --keys ABC-1,ABC-2 --apply
 *   Remove (sweep):  node scripts/backfill-namespaced-labels.js --unstamp --apply
 *
 * Env: CONFLUENCE_URL (or CONFLUENCE_BASE_URL), CONFLUENCE_EMAIL,
 *      CONFLUENCE_API_TOKEN (Jira reuses the Atlassian creds), JIRA_PROJECTS
 *      (comma-separated; the FIRST entry is backfilled). Optional JQL overrides:
 *      JIRA_OPEN_DEFECTS_STATUS_JQL, JIRA_DEFECT_ISSUETYPE_JQL. Optional
 *      ANTHROPIC_MODEL overrides the feature/flow matcher model.
 *
 * COST MODEL (#1355): the DEFAULT no-flag run is a FREE preview — it classifies
 * with the deterministic SYMPTOM-ONLY null classifier (no LLM, no spend) and
 * writes NOTHING. The paid production feature/flow classifier (#1343 — an LLM
 * matching issue text -> catalog ids, stamping the full `mb-feature-*` /
 * `mb-flow-*` set) is an explicit OPT-IN, constructed ONLY under `--real` (a paid
 * dry-run PREVIEW: classifies but does not write) or `--apply` (paid classify +
 * live write). `--symptom-only` forces the free null classifier even under
 * `--real` / `--apply`.
 *
 * SAFETY (nit 3): the catalog's `reviewed` flag gates BOTH paid paths —
 * `assertCatalogReviewed` fails closed BEFORE the production classifier is ever
 * constructed (no unreviewed, auto-distilled menu can drive a cost-incurring
 * run), and again before any live `--apply` Jira write.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DIST = path.resolve(__dirname, "..", "dist");
const { run, runUnstamp } = require(path.join(DIST, "triage", "backfill"));
const { loadKeywordExtensions } = require(path.join(DIST, "triage", "keywordExtensions"));
const { selectBackfillClassifier } = require(path.join(DIST, "triage", "selectBackfillClassifier"));
const { assertCatalogReviewed } = require(path.join(DIST, "catalog", "reviewedGate"));
const { buildOpenDefectsFetcher } = require(path.join(DIST, "jira", "sync"));
const {
  membershipFromCatalog,
  buildBotLabelJql,
} = require(path.join(DIST, "jira", "namespacedLabels"));
const {
  buildJiraNamespacedLabelWriter,
  GROWTH_PREFIXES,
} = require(path.join(DIST, "jira", "namespacedLabelWriter"));
const { resolveSnapThreshold } = require(path.join(DIST, "catalog", "catalogGrowth"));
const { proposeChild } = require(path.join(DIST, "triage", "growthProposer"));

/** Gitignored catalog path (mirrors src/catalog/cli.ts CATALOG_OUTPUT_PATH). */
const CATALOG_OUTPUT_PATH = path.resolve(
  __dirname,
  "..",
  ".ai-workspace",
  "catalog",
  "feature-catalog.json",
);

/** Gitignored full→lean parent map (#1387) — wires the DUAL bucket labels. */
const FULL_TO_LEAN_MAP_PATH = path.resolve(
  __dirname,
  "..",
  ".ai-workspace",
  "catalog",
  "full-to-lean-map.json",
);

/** Gitignored human-approval holding queue (#1387) for proposed growth. */
const PROPOSED_ADDITIONS_PATH = path.resolve(
  __dirname,
  "..",
  ".ai-workspace",
  "catalog",
  "proposed-additions.json",
);

/** Strip a trailing /wiki (and trailing slash) so the site root feeds Jira REST. */
function toSiteRoot(url) {
  return url.replace(/\/wiki\/?$/, "").replace(/\/$/, "");
}

function splitList(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Value following a `--flag` on argv (e.g. `--keys A,B` → "A,B"); else undefined. */
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Read the gitignored catalog (or an empty catalog if absent). */
function loadCatalog() {
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_OUTPUT_PATH, "utf8"));
    return {
      reviewed: raw.reviewed === true,
      features: Array.isArray(raw.features) ? raw.features : [],
      flows: Array.isArray(raw.flows) ? raw.flows : [],
    };
  } catch {
    return { reviewed: false, features: [], flows: [] };
  }
}

/**
 * Read the gitignored full→lean parent map (#1387) or an empty map if absent.
 * Returns the `parentOf` Map (full child id → lean bucket id) plus distinct lean
 * id lists: `featureLeanIds` (the feature-axis bucket menu / membership set) and
 * `distinctLeanIds` (all buckets — for the JQL enumeration). The map is derived
 * from catalog slugs (structure only), but it is gitignored and never printed.
 */
function loadParentMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(FULL_TO_LEAN_MAP_PATH, "utf8"));
    const features = raw.features && typeof raw.features === "object" ? raw.features : {};
    const flows = raw.flows && typeof raw.flows === "object" ? raw.flows : {};
    const parentOf = new Map([...Object.entries(features), ...Object.entries(flows)]);
    const featureLeanIds = [...new Set(Object.values(features))];
    const distinctLeanIds = [...new Set([...Object.values(features), ...Object.values(flows)])];
    return { parentOf, featureLeanIds, distinctLeanIds };
  } catch {
    return { parentOf: new Map(), featureLeanIds: [], distinctLeanIds: [] };
  }
}

/** Read the gitignored proposed-additions holding queue (or a fresh empty one). */
function loadProposedAdditions() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROPOSED_ADDITIONS_PATH, "utf8"));
    return {
      children: Array.isArray(raw.children) ? raw.children : [],
      proposedParents: Array.isArray(raw.proposedParents) ? raw.proposedParents : [],
    };
  } catch {
    return { children: [], proposedParents: [] };
  }
}

/** Read-modify-write the holding queue (append-only, deduped by slug). */
function persistProposedAdditions(state) {
  fs.mkdirSync(path.dirname(PROPOSED_ADDITIONS_PATH), { recursive: true });
  fs.writeFileSync(PROPOSED_ADDITIONS_PATH, JSON.stringify(state, null, 2) + "\n");
}

/**
 * The PRODUCTION `complete(prompt) → text` wrapper for the feature/flow matcher.
 * This is NEW (#1343): there is no pre-existing `complete()` helper — it is a
 * thin wrapper over the existing `getClient()` (`src/llm/anthropicClient.ts`),
 * mirroring build-catalog.js's `buildLlmDistiller`. getClient() is called
 * lazily (per classify) so the module never touches creds at import; tests of
 * the matcher core inject a fake `complete` and never reach this.
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

async function main() {
  const apply = process.argv.includes("--apply");
  // Paid dry-run PREVIEW: build the REAL production classifier but write NOTHING.
  const real = process.argv.includes("--real");
  const printJql = process.argv.includes("--print-jql");
  const unstamp = process.argv.includes("--unstamp");
  // Escape hatch: force the SYMPTOM-ONLY null classifier (the documented free
  // mode) even under --real/--apply, so debugging the deterministic axis is free.
  const symptomOnly = process.argv.includes("--symptom-only");
  // HYBRID growth (#1387): OFF by default. Paid (extra model call) → gated like
  // --real/--apply (assertCatalogReviewed before the proposer is constructed).
  const grow = process.argv.includes("--grow");
  // Graduation cleanup (#1387): peel ONLY the provisional/marker namespaces.
  const peelProvisional = process.argv.includes("--peel-provisional");
  // Runtime override of the PROVISIONAL dedup threshold (flag > env > default).
  const snapThresholdFlag = argValue("--snap-threshold");
  const keys = splitList(argValue("--keys"));
  const env = process.env;

  const catalog = loadCatalog();
  const parentMap = loadParentMap();

  if (printJql) {
    // Enumerated, sorted, quoted `labels in (...)` — NO wildcard. Safe to print:
    // the label STRINGS are derived from catalog ids (slugs), structure only.
    // #1387: also enumerate the PARENT bucket labels (one per distinct lean id).
    console.log(buildBotLabelJql(catalog, undefined, parentMap.distinctLeanIds));
    return;
  }

  const url = env.CONFLUENCE_URL || env.CONFLUENCE_BASE_URL;
  const email = env.CONFLUENCE_EMAIL;
  const apiToken = env.CONFLUENCE_API_TOKEN;
  const projects = splitList(env.JIRA_PROJECTS);

  if (!url || !email || !apiToken || projects.length === 0) {
    console.error(
      "backfill-namespaced-labels: missing config. Need CONFLUENCE_URL (or " +
        "CONFLUENCE_BASE_URL), CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, and a " +
        "non-empty JIRA_PROJECTS.",
    );
    process.exit(1);
  }

  const config = { baseUrl: toSiteRoot(url), email, apiToken };
  const scope = {
    statusJql: env.JIRA_OPEN_DEFECTS_STATUS_JQL,
    issueTypeJql: env.JIRA_DEFECT_ISSUETYPE_JQL,
  };
  const projectKey = projects[0];
  const fetcher = buildOpenDefectsFetcher(config, scope, globalThis.fetch);

  // UNSTAMP route (#1342): remove ALL the bot's labels. DRY-RUN by default; the
  // writer is constructed ONLY on --apply (mirrors the add path). Counts only.
  // #1387 --peel-provisional: peel ONLY the growth namespaces (graduation
  // cleanup) — leaves canonical child/parent/symptom labels intact.
  if (unstamp || peelProvisional) {
    const unstampDeps = {
      fetchOpenDefects: () => fetcher.fetchOpenDefects(projectKey),
      keys,
      apply,
      ...(peelProvisional ? { peelPrefixes: GROWTH_PREFIXES } : {}),
    };
    if (apply) {
      unstampDeps.writer = buildJiraNamespacedLabelWriter(config, globalThis.fetch);
    }
    const unstampResult = await runUnstamp(unstampDeps);
    if (!apply) {
      console.log(
        `\n(dry-run: no Jira writes performed. ${unstampResult.removable} issue(s) ` +
          "carry bot labels. Re-run with --apply to remove them.)",
      );
    } else {
      console.log(`\nremoved the bot's labels from ${unstampResult.removed} issue(s).`);
    }
    return;
  }

  // Cost-safe classifier selection (#1355): FREE null classifier by default;
  // the paid production classifier is built ONLY under --real/--apply, and the
  // catalog-reviewed gate fires (inside the seam) BEFORE it is ever constructed.
  // `buildProductionComplete` is passed as a FACTORY so getClient is never
  // touched on the free/symptom paths nor against an unreviewed catalog.
  const classifier = selectBackfillClassifier({
    apply,
    real,
    symptomOnly,
    catalog,
    completeFactory: buildProductionComplete,
    action: `backfill-namespaced-labels ${apply ? "--apply" : "--real"}`,
  });

  const deps = {
    fetchOpenDefects: () => fetcher.fetchOpenDefects(projectKey),
    classifier,
    // #1387: wire the full→lean parent map so DUAL child+parent labels are built.
    catalog: membershipFromCatalog(catalog, parentMap.parentOf),
    // Optional keyword extensions read from a gitignored local file (path via
    // MONDAY_KEYWORD_EXTENSIONS_FILE). Absent/malformed → {} → classify as today.
    extensions: loadKeywordExtensions(undefined, (msg) => console.error(msg)),
    apply,
  };

  // HYBRID growth wiring (#1387) — OFF unless --grow. PAID (extra model call) →
  // gated behind assertCatalogReviewed BEFORE the proposer is ever constructed,
  // same discipline as the --real/--apply classifier. Dry-run --grow previews
  // proposals + writes to the holding queue ONLY (no Jira write).
  if (grow) {
    assertCatalogReviewed(catalog, "backfill-namespaced-labels --grow");
    const proposed = loadProposedAdditions();
    // Dedup set: BARE canonical feature child slugs ∪ already-recorded
    // provisional slugs (so re-runs SNAP instead of re-minting).
    const existingChildSlugs = new Set([
      ...catalog.features.map((e) => String(e.id).replace(/^feature-/, "")),
      ...proposed.children.map((c) => c.slug),
    ]);
    const bucketIds = new Set(parentMap.featureLeanIds);
    // Humanize a lean id into a menu label (structure only; never logged).
    const bucketMenu = parentMap.featureLeanIds.map((id) => ({
      id,
      label: String(id).replace(/^feature-/, "").replace(/-/g, " "),
    }));
    const complete = buildProductionComplete();
    deps.growth = {
      grow: true,
      existingChildSlugs,
      bucketIds,
      threshold: resolveSnapThreshold({
        flag: snapThresholdFlag !== undefined ? Number(snapThresholdFlag) : undefined,
      }),
      propose: (issue) =>
        proposeChild(complete, bucketMenu, {
          summary: issue.summary,
          descriptionText: issue.descriptionText,
        }),
      record: (decision) => {
        const iso = new Date().toISOString();
        if (decision.kind === "queue-parent") {
          if (!proposed.proposedParents.some((p) => p.slug === decision.slug)) {
            proposed.proposedParents.push({
              slug: decision.slug,
              firstSeen: iso,
              reason: decision.reason,
            });
          }
        } else {
          // mint → provisional; queue-child → low-confidence.
          const status = decision.kind === "mint" ? "provisional" : "low-confidence";
          if (!proposed.children.some((c) => c.slug === decision.slug)) {
            proposed.children.push({
              slug: decision.slug,
              parentLeanId: decision.parentLeanId,
              firstSeen: iso,
              status,
            });
          }
          // Fold a minted slug into the live dedup set so this run is idempotent.
          if (decision.kind === "mint") existingChildSlugs.add(decision.slug);
        }
        persistProposedAdditions(proposed);
      },
    };
  }

  // The writer is constructed ONLY on --apply (dry-run never builds it). SAFETY
  // GATE (nit 3): a live write REFUSES to run against an unreviewed catalog.
  if (apply) {
    assertCatalogReviewed(catalog, "backfill-namespaced-labels --apply");
    deps.writer = buildJiraNamespacedLabelWriter(config, globalThis.fetch);
  }

  const result = await run(deps);

  if (!apply) {
    console.log(
      "\n(dry-run: no Jira writes performed. Re-run with --apply to stamp labels.)",
    );
  } else {
    console.log(`\napplied ${result.applied} issue label-set write(s).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
