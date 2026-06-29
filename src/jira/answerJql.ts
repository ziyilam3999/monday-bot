/**
 * `answerJql` factory (#1346) — wires the already-shipped NL→JQL viewing layer
 * (#1332) into the production Slack `adminService` so the `/jql` slash command
 * actually searches. This module is PURE WIRING: it composes the existing engine
 * (`buildVocab` → `buildLlmFilterMapper` → `buildJqlSearchFetcher` → `answerNlQuery`)
 * exactly as the working CLI `scripts/jql-from-nl.js` does, reading Atlassian
 * creds from env and running ONE read-only GET (Slack auto-run, option A).
 *
 * The composition lives behind a pure factory so the wiring is unit-testable with
 * ZERO network: `deps.search` (and `deps.fetchImpl`) are injectable seams. The
 * engine modules are READ-ONLY here — no new behavior, just the missing wire.
 *
 * PUBLIC repo: creds flow via env ONLY and are never logged/echoed/committed.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { parseDefaultProjects } from "../config/env";
import { buildVocab } from "./labelVocab";
import { buildLlmFilterMapper } from "./nlFilterMapper";
import { CatalogIdSource } from "./namespacedLabels";
import { buildJqlSearchFetcher, JqlSearchFetcher } from "./sync";
import { answerNlQuery } from "./nlToJql";
import { JqlReply } from "../slack/commands";

/**
 * Injectable seams for `buildAnswerJql`.
 *
 * - `env` — the credential source (defaults to `process.env` via the caller in
 *   `src/index.ts`). Read for `CONFLUENCE_URL`/`CONFLUENCE_BASE_URL`,
 *   `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`, and the optional
 *   `JIRA_DEFAULT_PROJECTS` (#1363 — default defect-search scope).
 * - `search` — override the read-only Jira search seam (the zero-network test
 *   seam). Production passes none → a real `buildJqlSearchFetcher` is built.
 * - `fetchImpl` — override the global fetch passed to the real fetcher (tests).
 * - `catalogPath` — override the gitignored catalog path (tests).
 */
export interface BuildAnswerJqlDeps {
  env: NodeJS.ProcessEnv;
  search?: JqlSearchFetcher;
  fetchImpl?: typeof fetch;
  catalogPath?: string;
}

/**
 * Strip a trailing `/wiki` (and trailing slash) so the site root feeds Jira REST.
 *
 * INLINE-MIRROR of the module-private `toSiteRoot` in `src/knowledge/startup.ts:83`
 * (NOT exported there) — the canonical twin. `scripts/jql-from-nl.js:54` mirrors
 * the identical one-liner. Keeping it inline keeps the `jira/` module
 * self-contained (no `jira/ → knowledge/` import edge) and the strip identical.
 * (Cairn T1 2026-06-22: ensure the site root is stored with `/wiki` stripped.)
 */
function toSiteRoot(url: string): string {
  return url.replace(/\/wiki\/?$/, "").replace(/\/$/, "");
}

/**
 * Read the gitignored catalog (or an empty catalog if absent / unreadable).
 *
 * Canonical twin: `scripts/jql-from-nl.js:31-51`. The CLI resolves the catalog
 * relative to its own `__dirname/..` (repo root); the compiled `dist/jira/...`
 * cannot reuse that anchor, so we resolve from `process.cwd()` — which is the
 * repo root for the production launch (`node dist/index.js`). Any other cwd (or a
 * missing catalog) safely degrades to the empty-catalog fallback, which is the
 * CURRENT intended production state (the feature/flow axis is inert pending #1343;
 * the symptom axis still works). NEVER throws.
 */
function loadCatalog(catalogPath?: string): CatalogIdSource {
  const resolved =
    catalogPath ??
    path.resolve(process.cwd(), ".ai-workspace", "catalog", "feature-catalog.json");
  try {
    const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return {
      features: Array.isArray(raw.features) ? raw.features : [],
      flows: Array.isArray(raw.flows) ? raw.flows : [],
    };
  } catch {
    return { features: [], flows: [] };
  }
}

/**
 * Build the production `answerJql(question)` method for the Slack `adminService`.
 *
 * Returns a function that maps an English defect question to JQL and runs ONE
 * read-only GET. NEVER throws: missing creds → a graceful "not configured"
 * `JqlReply`; the engine itself degrades to empty filters on any LLM error.
 */
export function buildAnswerJql(deps: BuildAnswerJqlDeps): (question: string) => Promise<JqlReply> {
  return async function answerJql(question: string): Promise<JqlReply> {
    // Step 1 — creds from env (mirrors startup.ts:120-122). Short-circuit BEFORE
    // building any fetcher → zero-network, never throws.
    const url = deps.env.CONFLUENCE_URL ?? deps.env.CONFLUENCE_BASE_URL;
    const email = deps.env.CONFLUENCE_EMAIL;
    const apiToken = deps.env.CONFLUENCE_API_TOKEN;
    if (!url || !email || !apiToken) {
      return { jql: "", issues: [], warnings: ["Jira credentials are not configured."] };
    }

    // Step 2 — load the gitignored catalog (empty fallback on any error).
    const catalog = loadCatalog(deps.catalogPath);

    // Step 3 — compose the seams (engine unchanged).
    const vocab = buildVocab(catalog);
    const mapper = buildLlmFilterMapper();
    const search =
      deps.search ??
      buildJqlSearchFetcher(
        { baseUrl: toSiteRoot(url), email, apiToken },
        deps.fetchImpl ?? globalThis.fetch,
      );

    // Step 4 — run the ONE read-only GET (Slack auto-run, option A). #1363 —
    // scope an empty-filter question to the configured default project(s) so the
    // search no longer degrades to a whole-site scan (unset → unchanged).
    const defaultProjects = parseDefaultProjects(deps.env.JIRA_DEFAULT_PROJECTS);
    const result = await answerNlQuery(question, {
      mapper,
      vocab,
      search,
      run: true,
      defaultProjects,
    });

    // Step 5 — map to the Slack `JqlReply` (drops the debug-only `filter`).
    return { jql: result.jql, issues: result.issues, warnings: result.warnings };
  };
}
