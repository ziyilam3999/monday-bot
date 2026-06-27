#!/usr/bin/env node
/*
 * categorize-defects.js — thin I/O shell over the injectable CLI core
 * (`dist/triage/cli.js` -> run(deps)).
 *
 * DRY-RUN by DEFAULT: reads the team's OPEN Jira defects, classifies each by
 * defect-type (deterministic rules engine), prints the per-defect plan + the
 * grouped-counts tally, and writes NOTHING. The real write-back is reachable
 * ONLY behind an explicit `--apply` flag (and needs operator go) — that is the
 * ONLY path that constructs the writer and mutates Jira.
 *
 * All creds + target come from env ONLY (gitignored .env; repo is public). The
 * env-cred construction lives HERE, in the outer shell — `run(deps)` itself is
 * cred-free + injectable so tests drive it against a fake.
 *
 *   Read it:   node scripts/categorize-defects.js            (dry-run preview)
 *   Apply it:  node scripts/categorize-defects.js --apply    (outward write)
 *
 * Env: CONFLUENCE_URL (or CONFLUENCE_BASE_URL), CONFLUENCE_EMAIL,
 *      CONFLUENCE_API_TOKEN (Jira reuses the Atlassian creds), JIRA_PROJECTS
 *      (comma-separated; the FIRST entry is categorized). Optional JQL overrides:
 *      JIRA_OPEN_DEFECTS_STATUS_JQL, JIRA_DEFECT_ISSUETYPE_JQL.
 */
"use strict";

const path = require("path");

const DIST = path.resolve(__dirname, "..", "dist");
const { run } = require(path.join(DIST, "triage", "cli"));
const { buildOpenDefectsFetcher } = require(path.join(DIST, "jira", "sync"));
const { buildJiraCategoryWriter } = require(path.join(DIST, "jira", "categoryWriter"));

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

async function main() {
  const apply = process.argv.includes("--apply");
  const env = process.env;

  const url = env.CONFLUENCE_URL || env.CONFLUENCE_BASE_URL;
  const email = env.CONFLUENCE_EMAIL;
  const apiToken = env.CONFLUENCE_API_TOKEN;
  const projects = splitList(env.JIRA_PROJECTS);

  if (!url || !email || !apiToken || projects.length === 0) {
    console.error(
      "categorize-defects: missing config. Need CONFLUENCE_URL (or CONFLUENCE_BASE_URL), " +
        "CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, and a non-empty JIRA_PROJECTS.",
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

  const deps = {
    fetchOpenDefects: () => fetcher.fetchOpenDefects(projectKey),
    apply,
  };
  // The writer is constructed ONLY on --apply (dry-run never builds it).
  if (apply) {
    deps.writer = buildJiraCategoryWriter(config, globalThis.fetch);
  }

  const result = await run(deps);

  if (!apply) {
    console.log(
      "\n(dry-run: no Jira writes performed. Re-run with --apply to write categories back.)",
    );
  } else {
    console.log(`\napplied ${result.applied} category write(s).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
