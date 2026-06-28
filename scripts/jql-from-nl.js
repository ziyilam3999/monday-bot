#!/usr/bin/env node
/*
 * jql-from-nl.js — thin I/O shell over the NL→JQL viewing layer (#1332).
 *
 * Turns an English question into a Jira JQL string. By DEFAULT it PRINTS the JQL
 * only (no network, no creds needed in MONDAY_TEST_MODE). With `--run` it ALSO
 * performs ONE read-only GET and prints the matched issue keys + summaries.
 *
 *   Print JQL:   MONDAY_TEST_MODE=1 node scripts/jql-from-nl.js "show me crashes"
 *   Print JQL:   node scripts/jql-from-nl.js "checkout crashes in DEMO"   (real LLM)
 *   Run it:      node scripts/jql-from-nl.js "show me crashes" --run       (read-only GET)
 *
 * The FUZZY English→labels step uses the LLM (Haiku tier); the EXACT labels→JQL
 * step is a PURE, deterministic builder. The internal feature/flow vocabulary is
 * read ONLY at runtime from the GITIGNORED catalog and never printed/committed.
 *
 * Env (only needed for --run): CONFLUENCE_URL (or CONFLUENCE_BASE_URL),
 *   CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN. Creds via env ONLY (repo is PUBLIC).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DIST = path.resolve(__dirname, "..", "dist");
const { buildVocab } = require(path.join(DIST, "jira", "labelVocab"));
const { buildLlmFilterMapper } = require(path.join(DIST, "jira", "nlFilterMapper"));
const { answerNlQuery } = require(path.join(DIST, "jira", "nlToJql"));
const { buildJqlSearchFetcher } = require(path.join(DIST, "jira", "sync"));

/** Gitignored catalog path (mirrors backfill-namespaced-labels.js). */
const CATALOG_OUTPUT_PATH = path.resolve(
  __dirname,
  "..",
  ".ai-workspace",
  "catalog",
  "feature-catalog.json",
);

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

/** Strip a trailing /wiki (and trailing slash) so the site root feeds Jira REST. */
function toSiteRoot(url) {
  return url.replace(/\/wiki\/?$/, "").replace(/\/$/, "");
}

async function main() {
  const argv = process.argv.slice(2);
  const run = argv.includes("--run");
  const question = argv.filter((a) => !a.startsWith("--")).join(" ").trim();

  if (!question) {
    console.error('Usage: node scripts/jql-from-nl.js "<question>" [--run]');
    process.exit(1);
  }

  const catalog = loadCatalog();
  const vocab = buildVocab(catalog);
  const mapper = buildLlmFilterMapper();

  let search;
  if (run) {
    const env = process.env;
    const url = env.CONFLUENCE_URL || env.CONFLUENCE_BASE_URL;
    const email = env.CONFLUENCE_EMAIL;
    const apiToken = env.CONFLUENCE_API_TOKEN;
    if (!url || !email || !apiToken) {
      console.error(
        "--run needs CONFLUENCE_URL (or CONFLUENCE_BASE_URL), CONFLUENCE_EMAIL, " +
          "CONFLUENCE_API_TOKEN in the environment.",
      );
      process.exit(1);
    }
    const config = { baseUrl: toSiteRoot(url), email, apiToken };
    search = buildJqlSearchFetcher(config, globalThis.fetch);
  }

  const result = await answerNlQuery(question, { mapper, vocab, search, run });

  // JQL first (the operator pastes this); warnings to stderr so stdout is clean.
  console.log(result.jql);
  for (const w of result.warnings) console.error(`warning: ${w}`);

  if (run && Array.isArray(result.issues)) {
    console.log("");
    if (result.issues.length === 0) {
      console.log("(no matching defects)");
    } else {
      for (const issue of result.issues) {
        console.log(issue.summary ? `${issue.key}\t${issue.summary}` : issue.key);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
