/**
 * Label-aware `/ask` augment (#1386) — bridges the doc Q&A path to the SAME
 * tagged-Jira-defect resolver the `/jql` command uses, WITHOUT perturbing the
 * cited doc answer.
 *
 * When an `/ask` question genuinely names a known feature/flow area (validated as
 * an ACTUAL catalog member — child or lean bucket), this surfaces that area's
 * tagged defects as an APPENDED block after the doc answer. When no known area is
 * named, or the kill-switch is off, or the catalog/creds have not landed, the
 * augment resolves to `null` and `/ask` is byte-identical to today.
 *
 * Design (mirrors `buildAnswerJql` — `src/jira/answerJql.ts`):
 *   - The factory does the BARE MINIMUM at build time: read the static kill-switch
 *     and close over `deps`. ALL catalog/vocab/mapper/search/Jira I/O lives inside
 *     the per-call closure, so `/ask` re-reads the catalog on EVERY call and flips
 *     to active the instant the data-gated catalog lands — in lockstep with `/jql`,
 *     no restart needed (B1).
 *   - The whole closure body is wrapped in one try/catch and NEVER throws (returns
 *     `null` on any error — creds, catalog read, vocab build, mapper LLM, Jira GET).
 *
 * PUBLIC repo: creds flow via env ONLY and are never logged/echoed/committed. No
 * value-bearing logs (preserves the axis-only warning discipline).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { parseDefaultProjects } from "../config/env";
import { slug } from "../catalog/slug";
import { JqlReplyIssue } from "../slack/commands";
import { buildVocab } from "./labelVocab";
import { buildLlmFilterMapper, NlFilterMapper } from "./nlFilterMapper";
import { CatalogIdSource } from "./namespacedLabels";
import { buildJqlSearchFetcher, JqlSearchFetcher } from "./sync";
import { answerNlQuery } from "./nlToJql";
import { LabelVocab, StructuredFilter } from "./jqlFromFilter";
import { BuildAnswerJqlDeps, envFlagOn, loadFullToLeanMap } from "./answerJql";

/** The full default cap on surfaced defect bullets (`ASK_DEFECTS_MAX`). */
const DEFAULT_ASK_DEFECTS_MAX = 5;

/**
 * The result the augment resolves to when an area IS named, validated, and has
 * tracked defects. `issues` is the FULL matched set — the visible cap (and the
 * `…and N more` overflow affordance) is applied downstream in the formatter.
 */
export interface AskAugmentResult {
  jql: string;
  issues: JqlReplyIssue[];
}

/**
 * Injectable seams for `buildAskJiraAugment`. Mirrors `BuildAnswerJqlDeps` plus an
 * optional `mapper` override so the per-call closure can be unit-tested with ZERO
 * network (a fake mapper + injected `search`).
 */
export type BuildAskAugmentDeps = BuildAnswerJqlDeps & { mapper?: NlFilterMapper };

/**
 * Strip a trailing `/wiki` (and trailing slash) so the site root feeds Jira REST.
 *
 * INLINE-MIRROR of the module-private `toSiteRoot` in `src/jira/answerJql.ts:56`
 * (itself a deliberate inline-mirror of `src/knowledge/startup.ts:83`). Re-inlining
 * keeps the `jira/` module self-contained and the strip one-liner identical, and
 * adds no new export edge.
 */
function toSiteRoot(url: string): string {
  return url.replace(/\/wiki\/?$/, "").replace(/\/$/, "");
}

/**
 * Read the gitignored catalog (or an empty catalog if absent / unreadable).
 *
 * INLINE-MIRROR of the module-private `loadCatalog` in `src/jira/answerJql.ts:71`.
 * Tiny never-throws JSON read anchored at `process.cwd()` (the repo root for the
 * production launch `node dist/index.js`). Any other cwd / a missing catalog safely
 * degrades to the empty-catalog fallback. NEVER throws.
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
 * Parse the `ASK_DEFECTS_MAX` integer knob (caps the visible defect bullets).
 *
 * INTEGER parse (NOT `envFlagOn` — this is a count, not a boolean): `parseInt`
 * base-10, with a `NaN` / `< 1` fall back to the default `5`, and a `Math.floor`
 * + clamp to a sane ceiling. Mirrors the `parseDefaultProjects` standalone-helper
 * style so the parse seam is unit-testable in isolation.
 */
export function parseAskDefectsMax(raw: string | undefined): number {
  const CEILING = 50;
  const n = parseInt((raw ?? "").trim(), 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_ASK_DEFECTS_MAX;
  return Math.min(Math.floor(n), CEILING);
}

/**
 * PURE, zero-I/O precision bar: which named areas in `filter` are ACTUAL catalog
 * members (child OR lean bucket). Mirrors `resolveCatalogAxis`'s child/bucket
 * membership test (`jqlFromFilter.ts`) but MEMBERSHIP-ONLY — there is NO
 * forward-compat passthrough, so a value on an EMPTY catalog never counts, and a
 * symptom-only / empty filter returns `[]`. Returns the matched slugs.
 */
export function resolveCatalogMatches(filter: StructuredFilter, vocab: LabelVocab): string[] {
  const matched: string[] = [];
  const check = (
    values: readonly string[] | undefined,
    childIds: ReadonlySet<string>,
    bucketIds: ReadonlySet<string> | undefined,
    idPrefix: string,
  ): void => {
    for (const raw of values ?? []) {
      const s = slug(raw ?? "");
      if (s.length === 0) continue;
      const id = `${idPrefix}${s}`;
      if (childIds.has(id) || (bucketIds?.has(id) ?? false)) matched.push(s);
    }
  };
  check(filter.features, vocab.featureIds, vocab.featureBucketIds, "feature-");
  check(filter.flows, vocab.flowIds, vocab.flowBucketIds, "flow-");
  return matched;
}

/**
 * Build the per-`/ask` Jira augment. The factory reads ONLY the static kill-switch
 * (`ASK_LABEL_AWARE`, default ON) at build time; everything data-gated lives in the
 * returned per-call closure (B1), so label-awareness activates the instant the
 * catalog + creds land — no restart.
 *
 * Returns `async (question) => AskAugmentResult | null`. Resolves to `null` (and
 * makes ZERO extra Jira/LLM calls) whenever: the switch is off, creds are missing,
 * the catalog is empty, the lexical pre-gate misses, no named area is a catalog
 * member, the Jira search errors, or the search returns no issues. NEVER throws.
 */
export function buildAskJiraAugment(
  deps: BuildAskAugmentDeps,
): (question: string) => Promise<AskAugmentResult | null> {
  // Build-time: the ONLY static read. Kill-switch off → a no-op closure that
  // makes zero downstream calls.
  if (!envFlagOn(deps.env.ASK_LABEL_AWARE)) {
    return async () => null;
  }

  return async function askAugment(question: string): Promise<AskAugmentResult | null> {
    try {
      // Creds — short-circuit BEFORE building any fetcher (mirror answerJql).
      const url = deps.env.CONFLUENCE_URL ?? deps.env.CONFLUENCE_BASE_URL;
      const email = deps.env.CONFLUENCE_EMAIL;
      const apiToken = deps.env.CONFLUENCE_API_TOKEN;
      if (!url || !email || !apiToken) return null;

      // Per-call catalog + vocab (re-read EVERY call → /jql lockstep, no restart).
      const catalog = loadCatalog(deps.catalogPath);
      const parentOf = envFlagOn(deps.env.JQL_ACCEPT_LEAN_VOCAB)
        ? loadFullToLeanMap(deps.mapPath)
        : undefined;
      const vocab = buildVocab(catalog, undefined, parentOf);

      // Empty-catalog short-circuit: no area can ever validate → don't call the
      // mapper or Jira (keeps /ask byte-identical in today's empty-catalog state,
      // now re-checked per call so it flips active the moment the catalog lands).
      const featureBuckets = vocab.featureBucketIds ?? new Set<string>();
      const flowBuckets = vocab.flowBucketIds ?? new Set<string>();
      if (
        vocab.featureIds.size === 0 &&
        vocab.flowIds.size === 0 &&
        featureBuckets.size === 0 &&
        flowBuckets.size === 0
      ) {
        return null;
      }

      // Lexical pre-gate (COST short-circuit only — NOT the precision bar). The
      // Haiku mapper stays behind it so English synonym → catalog label recall is
      // preserved. Build the stem token set (strip the axis prefixes off child +
      // bucket ids, then split hyphenated slugs into word tokens).
      const stemTokens = new Set<string>();
      const addStem = (id: string, prefix: string): void => {
        const stem = id.startsWith(prefix) ? id.slice(prefix.length) : id;
        for (const tok of stem.split("-")) if (tok.length > 0) stemTokens.add(tok);
      };
      for (const id of vocab.featureIds) addStem(id, "feature-");
      for (const id of vocab.flowIds) addStem(id, "flow-");
      for (const id of featureBuckets) addStem(id, "feature-");
      for (const id of flowBuckets) addStem(id, "flow-");
      // Guard: empty stem set → skip the pre-gate (belt-and-suspenders; the
      // empty-catalog short-circuit already returned null above).
      if (stemTokens.size > 0) {
        const questionTokens = (question.toLowerCase().match(/[a-z0-9]+/g) ?? []);
        const shares = questionTokens.some((t) => stemTokens.has(t));
        if (!shares) return null;
      }

      // Compose the seams (engine unchanged; mapper injectable for tests).
      const mapper = deps.mapper ?? buildLlmFilterMapper();
      const search =
        deps.search ??
        buildJqlSearchFetcher(
          { baseUrl: toSiteRoot(url), email, apiToken },
          deps.fetchImpl ?? globalThis.fetch,
        );

      // Map English → StructuredFilter with run:false (map + build, NO search).
      const res = await answerNlQuery(question, {
        mapper,
        vocab,
        run: false,
        defaultProjects: parseDefaultProjects(deps.env.JIRA_DEFAULT_PROJECTS),
        crossAxisUnion: envFlagOn(deps.env.JQL_CROSS_AXIS_UNION),
      });

      // Precision bar: a named area must be an ACTUAL catalog member.
      if (resolveCatalogMatches(res.filter, vocab).length === 0) return null;

      // ONE read-only GET. Return the FULL matched set (the formatter caps).
      const issues = await search.search(res.jql);
      return issues.length > 0 ? { jql: res.jql, issues } : null;
    } catch {
      // Any I/O path degrades to null — /ask still answers from the doc payload.
      return null;
    }
  };
}
