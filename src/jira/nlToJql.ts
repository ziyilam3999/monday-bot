/**
 * NL→JQL orchestrator (#1332): composes the FUZZY mapper → PURE builder →
 * (optional) read-only search into one call. Fully INJECTABLE — the mapper,
 * vocab and search seam are all passed in, so the whole pipeline is unit-tested
 * with stubs and ZERO network.
 *
 * `run` gates the (single) read-only GET: print-only when false/absent (the CLI
 * default), search-and-return-issues when true (the Slack auto-run default, and
 * the CLI `--run` flag). No writes anywhere on this path.
 */
import { buildJqlFromFilter, LabelVocab, StructuredFilter } from "./jqlFromFilter";
import { NlFilterMapper } from "./nlFilterMapper";
import { JiraIssue, JqlSearchFetcher } from "./sync";

export interface AnswerNlQueryDeps {
  /** The English→`StructuredFilter` mapper (LLM-backed or stub). */
  mapper: NlFilterMapper;
  /** The legal vocabulary the builder validates against. */
  vocab: LabelVocab;
  /** Read-only search seam; only consulted when `run` is true. */
  search?: JqlSearchFetcher;
  /** When true, perform the one read-only GET and attach matched issues. */
  run?: boolean;
  /**
   * Configured DEFAULT defect-project key(s) (#1363). When the mapper-resolved
   * filter names NO project, these scope the search via the builder's existing
   * `project in (...)` clause — so an empty-filter question no longer degrades to
   * a whole-site `statusCategory != Done` scan. A project NAMED in the question
   * always WINS (the default is never merged over / does not override it). Unset
   * / empty → behaviour unchanged.
   */
  defaultProjects?: string[];
  /**
   * #1392 cross-axis-union knob, forwarded to the pure builder. Default `true`
   * (the recall-restoring union). `false` → legacy pure-AND across axes.
   */
  crossAxisUnion?: boolean;
}

export interface NlQueryResult {
  jql: string;
  warnings: string[];
  /** Present only when `run` was true (the search was performed). */
  issues?: JiraIssue[];
  /** The structured filter the mapper produced (surfaced for debugging/tests). */
  filter: StructuredFilter;
}

/**
 * Map an English question to JQL, then optionally run the read-only search.
 * Never mutates Jira.
 */
export async function answerNlQuery(
  question: string,
  deps: AnswerNlQueryDeps,
): Promise<NlQueryResult> {
  const filter = await deps.mapper.map(question, deps.vocab);
  // #1363 — UPSTREAM default-project scoping. Only fill `projects` when the
  // mapper named none AND a default is configured; a question's explicit project
  // always wins. Build a scoped COPY (never mutate the mapper's filter).
  const needsDefault =
    (filter.projects?.length ?? 0) === 0 && (deps.defaultProjects?.length ?? 0) > 0;
  const scopedFilter = needsDefault
    ? { ...filter, projects: deps.defaultProjects! }
    : filter;
  const { jql, warnings } = buildJqlFromFilter(scopedFilter, deps.vocab, {
    crossAxisUnion: deps.crossAxisUnion ?? true,
  });
  const result: NlQueryResult = { jql, warnings, filter: scopedFilter };
  if (deps.run && deps.search) {
    result.issues = await deps.search.search(jql);
  }
  return result;
}
