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
 *   Read it:       node scripts/backfill-namespaced-labels.js            (dry-run)
 *   Apply it:      node scripts/backfill-namespaced-labels.js --apply    (outward write)
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
 *      JIRA_OPEN_DEFECTS_STATUS_JQL, JIRA_DEFECT_ISSUETYPE_JQL.
 *
 * NOTE: the production feature/flow classifier (LLM matching issue text ->
 * catalog ids) is a DEFERRED follow-up; until it ships this shell wires the
 * SYMPTOM-ONLY null classifier (the documented interim mode).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DIST = path.resolve(__dirname, "..", "dist");
const { run, runUnstamp } = require(path.join(DIST, "triage", "backfill"));
const { loadKeywordExtensions } = require(path.join(DIST, "triage", "keywordExtensions"));
const { buildNullClassifier } = require(path.join(DIST, "triage", "classifier"));
const { buildOpenDefectsFetcher } = require(path.join(DIST, "jira", "sync"));
const {
  membershipFromCatalog,
  buildBotLabelJql,
} = require(path.join(DIST, "jira", "namespacedLabels"));
const {
  buildJiraNamespacedLabelWriter,
} = require(path.join(DIST, "jira", "namespacedLabelWriter"));

/** Gitignored catalog path (mirrors src/catalog/cli.ts CATALOG_OUTPUT_PATH). */
const CATALOG_OUTPUT_PATH = path.resolve(
  __dirname,
  "..",
  ".ai-workspace",
  "catalog",
  "feature-catalog.json",
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
      features: Array.isArray(raw.features) ? raw.features : [],
      flows: Array.isArray(raw.flows) ? raw.flows : [],
    };
  } catch {
    return { features: [], flows: [] };
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const printJql = process.argv.includes("--print-jql");
  const unstamp = process.argv.includes("--unstamp");
  const keys = splitList(argValue("--keys"));
  const env = process.env;

  const catalog = loadCatalog();

  if (printJql) {
    // Enumerated, sorted, quoted `labels in (...)` — NO wildcard. Safe to print:
    // the label STRINGS are derived from catalog ids (slugs), structure only.
    console.log(buildBotLabelJql(catalog));
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
  if (unstamp) {
    const unstampDeps = {
      fetchOpenDefects: () => fetcher.fetchOpenDefects(projectKey),
      keys,
      apply,
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

  const deps = {
    fetchOpenDefects: () => fetcher.fetchOpenDefects(projectKey),
    classifier: buildNullClassifier(),
    catalog: membershipFromCatalog(catalog),
    // Optional keyword extensions read from a gitignored local file (path via
    // MONDAY_KEYWORD_EXTENSIONS_FILE). Absent/malformed → {} → classify as today.
    extensions: loadKeywordExtensions(undefined, (msg) => console.error(msg)),
    apply,
  };
  // The writer is constructed ONLY on --apply (dry-run never builds it).
  if (apply) {
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
