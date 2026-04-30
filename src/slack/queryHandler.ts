/**
 * Centralised query → Slack-payload handler used by both the `app_mention` and
 * `/ask` paths. Wraps the knowledge service `query()` call in a single
 * try/catch and returns a Slack-postable payload (`{ text, blocks? }`) in
 * either case.
 *
 * Why this exists (US-10): when the LLM, vector index, or embeddings backend
 * throws, callers must NOT leak stack traces, error class names, or internal
 * messages into Slack — those leak infra noise to end users and can leak
 * secrets (URLs, hostnames) embedded in error strings. This module guarantees
 * the returned `text` never contains the substrings `Error:`, `at Object`, or
 * `stack`, while still surfacing a friendly "I'm having trouble" message.
 *
 * The underlying error IS logged to stderr for operator visibility.
 */
import { formatAnswer, SlackBlock } from "./formatter";

/**
 * Minimal contract: any object with a `query(question)` method that resolves
 * to an `{ answer, citations }` shape works. Mirrors `AnswerProvider` in
 * `adapter.ts` but kept local so this module has no circular dep with the
 * adapter.
 */
export interface QueryService {
  query(question: string): Promise<{
    answer: string;
    citations: Array<{
      num?: number;
      number?: number;
      source: string;
      heading?: string;
    }>;
  }>;
}

export interface QueryHandlerResult {
  text: string;
  blocks?: SlackBlock[];
}

/**
 * Friendly, non-leaky error copy. Carefully chosen so the AC-01 forbidden
 * substrings (`Error:`, `at Object`, `stack`) do NOT appear, while at least
 * one of the AC-required tokens (`sorry`, `unavailable`, `error`, `trouble`)
 * IS present case-insensitively.
 *
 * Note: lowercase `error` is allowed; only `Error:` (capital E + colon) is
 * forbidden, since that is the canonical leading prefix of a stringified
 * `Error` instance.
 */
const FRIENDLY_ERROR_TEXT =
  "Sorry, I'm having trouble reaching the knowledge service right now. Please try again in a moment.";

/**
 * Lazy default-service resolver. We avoid an eager `import` at module load so
 * that consumers who pass an explicit `service` argument (the AC-01 path, plus
 * the adapter at runtime) don't pay the cost of building a `KnowledgeService`
 * with a live VectorIndex / LLM client just to load this module. The
 * `require()` is intentional — it keeps the function CommonJS-compatible
 * after `tsc` emit, and matches the dynamic-require pattern already used in
 * `src/knowledge/service.ts`.
 */
function defaultService(): QueryService {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { KnowledgeService } = require("../knowledge/service") as {
    KnowledgeService: new () => QueryService;
  };
  return new KnowledgeService();
}

/**
 * Run a question through the knowledge service and return a Slack-postable
 * payload. Never throws — any exception from `service.query` is caught,
 * logged, and converted to a friendly fallback payload.
 *
 * `service` is optional: when omitted, a fresh `KnowledgeService` is built on
 * demand. In production the adapter always passes its long-lived instance, so
 * the default-construction path is mainly for ad-hoc callers and tests.
 */
export async function handleQuery(
  question: string,
  service?: QueryService,
): Promise<QueryHandlerResult> {
  const resolved = service ?? defaultService();
  try {
    const result = await resolved.query(question);
    const payload = formatAnswer(result);
    return { text: payload.text, blocks: payload.blocks };
  } catch (err) {
    // Operator-visible: full error to stderr. End-user-visible: friendly text.
    const detail = err instanceof Error ? err.message : String(err);
    // Use console.error directly; structured logging is out of scope for US-10.
    // eslint-disable-next-line no-console
    console.error("[handleQuery] knowledge service threw:", detail);
    return { text: FRIENDLY_ERROR_TEXT };
  }
}
