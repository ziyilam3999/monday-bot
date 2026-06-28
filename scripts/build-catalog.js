#!/usr/bin/env node
/*
 * build-catalog.js — thin I/O shell over the injectable catalog CLI core
 * (`dist/catalog/cli.js` -> run(deps)).
 *
 * Reads every page of a Confluence space (REUSING the real fetcher — no
 * re-implemented pagination), asks ONE LLM distiller to draft a feature/flow
 * "menu", and writes it to a GITIGNORED file the operator then reviews/edits.
 *
 * Privacy: the catalog carries internal product names, so it is written ONLY to
 * the gitignored output path. stdout shows COUNTS/STRUCTURE ONLY — never a
 * label, page body/title/id, space key, host, or email. All creds + targets
 * come from env ONLY (gitignored .env; this repo is PUBLIC). The env-cred
 * construction lives HERE, in the outer shell — `run(deps)` itself is cred-free
 * and injectable so tests drive it against fakes.
 *
 *   Build it:  node --env-file=.env scripts/build-catalog.js
 *
 * Env: CONFLUENCE_URL (or CONFLUENCE_BASE_URL), CONFLUENCE_EMAIL,
 *      CONFLUENCE_API_TOKEN, CONFLUENCE_SPACES (comma-separated; the FIRST entry
 *      is cataloged). Optional ANTHROPIC_MODEL overrides the distiller model.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DIST = path.resolve(__dirname, "..", "dist");
// Reuses the REAL paginating fetcher from dist/confluence/sync (#1309) — the
// shell wires its bound `fetchPages` in as the injected read seam; the catalog
// module never re-implements pagination/endpoints (AC-REUSE-FETCHER).
const { run, CATALOG_OUTPUT_PATH, CATALOG_REGENERATED_PATH, chooseWritePath } = require(
  path.join(DIST, "catalog", "cli"),
);
const { buildConfluenceFetcher } = require(path.join(DIST, "confluence", "sync"));
const { getClient } = require(path.join(DIST, "llm", "anthropicClient"));

/** Strip a trailing /wiki (and trailing slash) so buildConfluenceFetcher gets the site root. */
function toSiteRoot(url) {
  return url.replace(/\/wiki\/?$/, "").replace(/\/$/, "");
}

function splitList(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The production CatalogDistiller — the single LLM boundary. Wraps
 * getClient().messages.create() and parses a strict JSON reply. Tests NEVER
 * reach this (they inject a fake), so the unit suite makes zero model calls.
 */
function buildLlmDistiller() {
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  return {
    async distill(pages) {
      const client = getClient();
      const corpus = pages
        .map((p) => `### PAGE id=${p.id} title=${JSON.stringify(p.title)}\n${p.body}`)
        .join("\n\n");
      const instructions =
        "You are cataloging a product's wiki. From the pages below, produce a JSON " +
        "object with two arrays: `features` (the product's capabilities) and `flows` " +
        "(the journeys a user takes). Each array element is " +
        '`{ "label": string, "provenancePageIds": string[] }`, where provenancePageIds ' +
        "are the `id` values of the pages that entry was drawn from. Respond with JSON ONLY.";
      const res = await client.messages.create({
        model,
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: "user", content: `${instructions}\n\n${corpus}` }],
      });
      const text = Array.isArray(res.content)
        ? res.content
            .filter((b) => b && b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("")
        : "";
      const jsonStart = text.indexOf("{");
      const jsonEnd = text.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        throw new Error("catalog distiller: model reply contained no JSON object");
      }
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      return {
        features: Array.isArray(parsed.features) ? parsed.features : [],
        flows: Array.isArray(parsed.flows) ? parsed.flows : [],
      };
    },
  };
}

async function main() {
  const env = process.env;
  const url = env.CONFLUENCE_URL || env.CONFLUENCE_BASE_URL;
  const email = env.CONFLUENCE_EMAIL;
  const apiToken = env.CONFLUENCE_API_TOKEN;
  const spaces = splitList(env.CONFLUENCE_SPACES);

  if (!url || !email || !apiToken || spaces.length === 0) {
    console.error(
      "build-catalog: missing config. Need CONFLUENCE_URL (or CONFLUENCE_BASE_URL), " +
        "CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, and a non-empty CONFLUENCE_SPACES.",
    );
    process.exit(1);
  }

  const config = { baseUrl: toSiteRoot(url), email, apiToken };
  const spaceKey = spaces[0];
  const fetcher = buildConfluenceFetcher(config, globalThis.fetch);

  // No-clobber sink: write to the regenerated sibling if a catalog already
  // exists (don't overwrite operator edits); else to the primary path.
  const writeCatalog = async (catalog) => {
    const target = chooseWritePath(CATALOG_OUTPUT_PATH, CATALOG_REGENERATED_PATH, fs.existsSync);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`, "utf-8");
  };

  const result = await run({
    fetchPages: (key) => fetcher.fetchPages(key),
    distiller: buildLlmDistiller(),
    writeCatalog,
    spaceKey,
  });

  // Counts/structure ONLY — never a label, body, id, space key, host, or email.
  console.log(
    `\nDone: ${result.pagesIngested} pages ingested, ${result.featureCount} features, ` +
      `${result.flowCount} flows distilled.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
