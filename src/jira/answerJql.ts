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
 * - `mapPath` — override the gitignored full→lean map path (#1385, tests).
 */
export interface BuildAnswerJqlDeps {
  env: NodeJS.ProcessEnv;
  search?: JqlSearchFetcher;
  fetchImpl?: typeof fetch;
  catalogPath?: string;
  mapPath?: string;
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
 * Read the gitignored full→lean map (#1385) into a flat `parentOf` map
 * (`fullChildId → leanBucketId`) merged across the `features` + `flows` sections.
 * Resolved from `process.cwd()` like `loadCatalog`. NEVER throws: an absent or
 * malformed map yields an EMPTY map, so the lean-vocab feature is a genuine no-op
 * when the map has not landed (behaviour identical to pre-#1385). Exported for
 * the zero-I/O unit test seam (the real map is gitignored + runtime-only).
 */
export function loadFullToLeanMap(mapPath?: string): Map<string, string> {
  const resolved =
    mapPath ?? path.resolve(process.cwd(), ".ai-workspace", "catalog", "full-to-lean-map.json");
  const out = new Map<string, string>();
  try {
    const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
    for (const axis of ["features", "flows"] as const) {
      const section = raw?.[axis];
      if (section && typeof section === "object") {
        for (const [childId, leanId] of Object.entries(section)) {
          if (typeof leanId === "string" && leanId.length > 0) out.set(childId, leanId);
        }
      }
    }
  } catch {
    // absent / malformed → empty map (behaviour unchanged). NEVER throws.
  }
  return out;
}

/**
 * Read an env flag that defaults ON (#1385/#1392 knobs). Any value except `"0"`
 * / `"false"` (case-insensitive, trimmed) keeps the feature ON; an UNSET flag is
 * ON. `=0`/`=false` is the explicit kill-switch.
 *
 * EXPORTED (#1386) — the single source of truth for the ON-by-default flag
 * semantics shared by the `JQL_*` knobs and the new `ASK_LABEL_AWARE` kill-switch
 * (`src/jira/askAreaAugment.ts`). One definition avoids a forked truth-table.
 */
export function envFlagOn(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return v !== "0" && v !== "false";
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

    // #1385 — full↔lean vocab knob (default ON, genuinely data-gated: no/empty
    // map ⇒ no buckets ⇒ behaviour identical to today). When OFF, pass NO
    // parentOf so buckets are neither offered to the LLM nor accepted.
    const acceptLeanVocab = envFlagOn(deps.env.JQL_ACCEPT_LEAN_VOCAB);
    const parentOf = acceptLeanVocab ? loadFullToLeanMap(deps.mapPath) : undefined;
    // #1392 — cross-axis union knob (default ON).
    const crossAxisUnion = envFlagOn(deps.env.JQL_CROSS_AXIS_UNION);

    // Step 3 — compose the seams (engine unchanged).
    const vocab = buildVocab(catalog, undefined, parentOf);
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
      crossAxisUnion,
    });

    // Step 5 — map to the Slack `JqlReply` (drops the debug-only `filter`).
    return { jql: result.jql, issues: result.issues, warnings: result.warnings };
  };
}
