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
  const { jql, warnings } = buildJqlFromFilter(filter, deps.vocab);
  const result: NlQueryResult = { jql, warnings, filter };
  if (deps.run && deps.search) {
    result.issues = await deps.search.search(jql);
  }
  return result;
}
