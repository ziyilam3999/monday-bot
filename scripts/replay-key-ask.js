#!/usr/bin/env node
/**
 * #3378 — replay one question through the real answer path (KnowledgeService
 * + buildIssueLookupFromEnv), loading env exactly as the bot does
 * (process.loadEnvFile from the repo dir). Needs a built tree (npm run build).
 *
 * Prints ONLY: the extracted key(s), index size, the Jira HTTP code and status
 * name from one direct read-only GET, the answer's facts line and its first
 * line. Never prints credentials or Jira body text.
 *
 * Usage: HOME=<empty-login-dir> node scripts/replay-key-ask.js "<question>"
 */
const path = require("node:path");

async function main() {
  const question = process.argv[2];
  if (!question) {
    console.error("usage: replay-key-ask.js <question>");
    process.exit(2);
  }
  process.chdir(path.join(__dirname, ".."));
  // Default: .env in the repo dir (as the bot). REPLAY_ENV_FILE points a
  // worktree at the primary checkout's env file.
  process.loadEnvFile(process.env.REPLAY_ENV_FILE || ".env");
  delete process.env.MONDAY_TEST_MODE;

  const { KnowledgeService } = require("../dist/knowledge/service");
  const { buildIssueLookupFromEnv } = require("../dist/knowledge/startup");
  const { extractIssueKeys } = require("../dist/knowledge/keyLookup");

  const lookup = buildIssueLookupFromEnv(process.env);
  if (!lookup) {
    console.log("lookup=undefined (no JIRA_PROJECTS)");
    process.exit(1);
  }
  const keys = extractIssueKeys(question, lookup.projectKeys);
  console.log(`extracted=${JSON.stringify(keys)}`);

  // Direct read-only GET for the expected status name + HTTP code.
  if (keys.length > 0) {
    const base = (process.env.CONFLUENCE_URL ?? process.env.CONFLUENCE_BASE_URL ?? "")
      .replace(/\/wiki\/?$/, "")
      .replace(/\/$/, "");
    const auth = Buffer.from(
      `${process.env.CONFLUENCE_EMAIL}:${process.env.CONFLUENCE_API_TOKEN}`,
    ).toString("base64");
    const res = await fetch(`${base}/rest/api/3/issue/${keys[0]}?fields=status`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    let name = "?";
    if (res.ok) name = (await res.json()).fields?.status?.name ?? "?";
    console.log(`jira_http=${res.status} direct_status=${name}`);
  }

  const svc = new KnowledgeService({ issueLookup: lookup });
  // Seed a NON-EMPTY index (an empty index short-circuits before the key leg).
  await svc.indexConfluencePage({
    id: "replay-seed",
    title: "Replay seed",
    body: "Replay seed passage so the index is non-empty.",
    source: "replay:seed",
    spaceKey: "REPLAY",
  });
  console.log("index=seeded 1 passage (non-empty)");

  const result = await svc.query(question);
  const lines = String(result.answer).split("\n");
  const facts = lines.find((l) => /^[A-Z][A-Z0-9]*-\d+ — Status:/.test(l));
  console.log(`facts_line=${facts ?? "(none)"}`);
  console.log(`answer_line1=${lines[0]}`);
}

main().catch((e) => {
  console.error(`replay failed: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
