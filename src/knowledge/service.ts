import { ingestFile, Chunk as IngestChunk } from "../ingestion/ingest";
import { splitIntoPassages } from "../ingestion/chunkText";
import { VectorIndex, SearchResult, Chunk as IndexChunk } from "../index/vectorIndex";
import { generateAnswer, Chunk as LlmChunk, Citation } from "../llm/generate";
import { expandQuery, QueryExpansionConfig } from "./queryExpansion";
import { applyDiversityCap, DiversityCapConfig } from "./diversity";
import { rerank, RerankConfig } from "./rerank";
import {
  applyDocPrior,
  DocPriorConfig,
  DEFAULT_DOC_PRIOR_BONUS,
  DEFAULT_DOC_SOURCE_TYPES,
} from "./docPrior";
import { extractIssueKeys } from "./keyLookup";

// Raised 5 -> 12 (#1189): passage-chunking can fill several top slots with
// passages from the same doc, so a wider window leaves room for the relevant
// passage AND cross-doc coverage. `opts.topK` still overrides per-service.
const DEFAULT_TOP_K = 12;
const NO_DOCUMENTS_ANSWER =
  "I couldn't find any relevant information in the indexed documents to answer this question.";

/**
 * 3286 Part A (AC-3): truthful answers for the two empty-index states that are
 * NOT "no relevant information". Both are served only while the index is EMPTY
 * (any indexed documents answer normally from what is there — partial beats
 * refusal), and the "no sources configured at all" case keeps the old
 * NO_DOCUMENTS_ANSWER so a misconfigured bot cannot hide behind "warming up".
 */
/**
 * #3299 — exact-key lookup leg. A question that NAMES an issue key pins that
 * issue's chunks first (or live-fetches exactly that issue when unindexed).
 * Bounds: at most MAX_NAMED_KEYS distinct keys resolved per question;
 * <= MAX_CHUNKS_PER_NAMED_SOURCE chunks per named source (its first passages
 * in index order); the named chunks DISPLACE the vector tail (total context
 * stays topK — they never grow it); each live fetch is time-boxed
 * (LIVE_FETCH_TIMEOUT_MS) and the whole live leg of one question carries a
 * deadline (LIVE_LEG_DEADLINE_MS). Leg composition: SEQUENTIAL fetches in
 * first-mention order, each budgeted min(per-fetch bound, remaining leg time)
 * — a slow early fetch therefore shrinks (and can exhaust) later fetches'
 * budgets rather than overshooting the leg bound (plan-review r2 LOW-2).
 */
const MAX_NAMED_KEYS = 3;
const MAX_CHUNKS_PER_NAMED_SOURCE = 3;
const LIVE_FETCH_TIMEOUT_MS = 5_000;
const LIVE_LEG_DEADLINE_MS = 10_000;

/**
 * One issue as returned by the live one-issue fetch seam (`IssueFetcher` in
 * src/jira/sync.ts — structurally this shape; no runtime dep from here on Jira).
 */
export interface LiveIssue {
  key: string;
  summary: string;
  descriptionText: string;
  commentTexts: string[];
  /**
   * #3307 — live metadata for the facts line, mapped only when the fetch
   * requested those fields (the one-issue fetcher does; old stubs don't).
   */
  meta?: IssueMeta;
}

/**
 * #3307 — live issue metadata. Display-safe values only: `assignee` is the
 * tracker DISPLAY NAME (the Jira mapper reads `displayName` and nothing else,
 * so an email cannot reach an answer). `null` is an explicit tracker value —
 * unassigned / unresolved / priority not set — and renders as a plain wording;
 * `undefined` means the field was absent from the fetch and the facts-line
 * segment is omitted, never guessed.
 */
export interface IssueMeta {
  status?: string;
  assignee?: string | null;
  priority?: string | null;
  resolution?: string | null;
  /** Raw tracker timestamp (ISO); only its date part is rendered. */
  updated?: string;
}

/** Read-only one-issue fetch seam for the #3299 live leg. */
export interface IssueFetcher {
  fetchIssue(key: string): Promise<LiveIssue | null>;
}

/** #3299 exact-key lookup wiring: configured projects + optional live fetcher. */
export interface IssueLookupOptions {
  /** Configured project keys (JIRA_PROJECTS). Question prefixes match these
   * case-insensitively; emitted keys use the list's OWN casing. */
  projectKeys: string[];
  /**
   * One-issue read-only fetcher. Without it, an unindexed named key has no live
   * leg: no fetch, no honest-miss copy — the question falls back to the plain
   * vector answer (Jira not configured must not fabricate "not found").
   */
  issueFetcher?: IssueFetcher;
}

/** Sentinel rejection reason for `withTimeout` — distinguishes expiry from a
 * fetch error so the honest-miss copy can say "timed out" truthfully. */
const FETCH_TIMEOUT = "issue-fetch-timeout";

/** Honest-miss line for a key Jira did not hand back (absent or not visible). */
const keyMissLine = (key: string): string =>
  `${key}: not found or not visible in Jira.`;
/** Honest-miss line for a key whose lookup exceeded its time budget. */
const keyTimeoutLine = (key: string): string =>
  `${key}: the live lookup timed out, so I have no fresh answer for that ticket.`;

/**
 * #3307 — honest line when an INDEXED key's facts fetch missed, errored or
 * timed out: the pinned retelling stays (from the indexed copy) and NO facts
 * value appears — the line names the missing fields without inventing any.
 */
const keyMetaFailLine = (key: string): string =>
  `Current status, assignee and priority for ${key} could not be fetched from Jira; ` +
  `the summary below is the indexed copy, which may be stale.`;

/**
 * #3307 — the facts line for a named key, assembled by CODE from the fetched
 * live fields (the #3299 prelude pattern — never left for the model to infer):
 * `DEMO-673 — Status: … · Assignee: … · Priority: … · Resolution: … · Updated: …
 * (live, fetched from Jira just now).` Every value is labelled live; empty
 * tracker values get plain wordings (Unassigned / Unresolved / not set); a
 * field genuinely absent from the fetch is omitted — nothing is guessed. Only
 * the DATE part of `updated` is rendered. Returns null when the fetch carried
 * no metadata at all (an issue fetched by a pre-#3307 fetcher shape).
 */
function renderIssueFactsLine(key: string, meta: IssueMeta | undefined): string | null {
  if (!meta) return null;
  const segs: string[] = [`Status: ${meta.status ?? "not set"}`];
  if (meta.assignee !== undefined) segs.push(`Assignee: ${meta.assignee ?? "Unassigned"}`);
  if (meta.priority !== undefined) segs.push(`Priority: ${meta.priority ?? "not set"}`);
  if (meta.resolution !== undefined) segs.push(`Resolution: ${meta.resolution ?? "Unresolved"}`);
  if (meta.updated !== undefined) segs.push(`Updated: ${meta.updated.slice(0, 10)}`);
  return `${key} — ${segs.join(" · ")} (live, fetched from Jira just now).`;
}

const WARMING_UP_ANSWER =
  "I'm still warming up — the knowledge index is being built for the first time. Please ask again in a few minutes.";
const SYNC_FAILED_ANSWER =
  "My first knowledge sync didn't complete, so I have nothing to search yet. Please check the sync logs, or ask again after a successful sync.";

/**
 * Lifecycle of the initial (boot) sync, as tracked by `startKnowledgeSources`
 * and consumed by `query()`'s empty-index branch (AC-3):
 *   not-started → in-flight → settled | failed
 * "failed" means EVERY wired initial sync errored (errors are caught so
 * `ready` still resolves); a partial success settles normally.
 */
export type InitialSyncPhase = "not-started" | "in-flight" | "settled" | "failed";

/**
 * Recall v2 ranking levers (#1191). Threaded from `config.yaml` → `AppConfig`
 * → here at the production construction site (src/index.ts). Defaults below ARE
 * the SHIPPED defaults: expansion ON, diversity cap ON, rerank OFF — so the
 * feature is LIVE-BY-DEFAULT even for a caller that passes no `recall` block
 * (correction #1: the feature must never ship inert).
 */
export interface RecallConfig {
  queryExpansion?: QueryExpansionConfig;
  diversityCap?: DiversityCapConfig;
  rerank?: RerankConfig;
  /**
   * Lever 4 (#1197) — how-to-action doc-over-ticket prior. Default ON (see
   * resolveRecall): the Tier-B controls hold 5/5 and Q3/Q4 do not regress, so an
   * always-on cheap re-rank is conservative (correction #4).
   */
  docPrior?: DocPriorConfig;
  /** Bi-encoder search pool widened when rerank OR diversity cap is enabled. */
  candidatePoolSize?: number;
}

/** Fully-resolved recall config — every field defaulted. */
interface ResolvedRecall {
  expansion: { enabled: boolean };
  diversityCap: { enabled: boolean; maxPerSourceType: number };
  rerank: RerankConfig & { enabled: boolean; candidatePool: number };
  docPrior: { enabled: boolean; bonus: number; docSourceTypes: readonly string[] };
  candidatePoolSize: number;
}

const DEFAULT_CANDIDATE_POOL = 150;
const DEFAULT_MAX_PER_SOURCE_TYPE = 6;

function resolveRecall(cfg?: RecallConfig): ResolvedRecall {
  return {
    expansion: { enabled: cfg?.queryExpansion?.enabled ?? true },
    diversityCap: {
      enabled: cfg?.diversityCap?.enabled ?? true,
      maxPerSourceType:
        cfg?.diversityCap?.maxPerSourceType ?? DEFAULT_MAX_PER_SOURCE_TYPE,
    },
    rerank: {
      ...(cfg?.rerank ?? {}),
      enabled: cfg?.rerank?.enabled ?? false,
      candidatePool: cfg?.rerank?.candidatePool ?? DEFAULT_CANDIDATE_POOL,
    },
    docPrior: {
      // Default ON (correction #4): justified by Tier-B — controls 5/5, no
      // Q3/Q4 regression. The bonus is the single tunable knob; a small additive
      // value (0.10) lands the how-to doc inside the #1-3 grounding window.
      enabled: cfg?.docPrior?.enabled ?? true,
      bonus: cfg?.docPrior?.bonus ?? DEFAULT_DOC_PRIOR_BONUS,
      docSourceTypes:
        cfg?.docPrior?.docSourceTypes ?? DEFAULT_DOC_SOURCE_TYPES,
    },
    candidatePoolSize: cfg?.candidatePoolSize ?? DEFAULT_CANDIDATE_POOL,
  };
}

export interface QueryResult {
  answer: string;
  citations: Citation[];
}

/**
 * Shape passed to `KnowledgeService.indexConfluencePage`. Only `id` and `body`
 * are strictly required; `source` defaults to `confluence:<id>` if omitted.
 */
export interface ConfluencePageInput {
  id: string;
  title?: string;
  body: string;
  source?: string;
  spaceKey?: string;
}

export interface ServiceStatus {
  documentCount: number;
  uptimeSeconds: number;
}

export interface AnswerGenerator {
  (question: string, chunks: LlmChunk[]): Promise<{ answer: string; citations: Citation[] }>;
}

export interface FileIngestor {
  (absolutePath: string): Promise<IngestChunk[]>;
}

export interface KnowledgeServiceOptions {
  index?: VectorIndex;
  ingest?: FileIngestor;
  generator?: AnswerGenerator;
  topK?: number;
  now?: () => number;
  /**
   * Recall v2 ranking levers (#1191). Omitted/partial → SHIPPED defaults
   * (expansion ON, diversity cap ON, rerank OFF). Threaded from config.yaml at
   * the production construction site (src/index.ts).
   */
  recall?: RecallConfig;
  /**
   * #3299 — exact-key lookup leg. Omitted → the question path is byte-identical
   * to today's (extraction runs only when project keys are configured).
   */
  issueLookup?: IssueLookupOptions;
}

function toLlmChunk(result: SearchResult): LlmChunk {
  const out: LlmChunk = {
    id: result.id,
    text: result.text,
    source: result.source,
    score: result.score,
  };
  if (result.heading !== undefined) out.heading = result.heading;
  if (result.section !== undefined) out.section = result.section;
  return out;
}

export class KnowledgeService {
  private readonly vectorIndex: VectorIndex;
  private readonly ingest: FileIngestor;
  private readonly generator: AnswerGenerator;
  private readonly topK: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly indexedSources = new Set<string>();
  private readonly recall: ResolvedRecall;
  private readonly issueLookup: IssueLookupOptions | undefined;
  private initialSyncPhase: InitialSyncPhase = "not-started";

  constructor(opts: KnowledgeServiceOptions = {}) {
    this.vectorIndex = opts.index ?? new VectorIndex();
    this.ingest = opts.ingest ?? ingestFile;
    this.generator = opts.generator ?? generateAnswer;
    this.topK = opts.topK ?? DEFAULT_TOP_K;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.recall = resolveRecall(opts.recall);
    this.issueLookup = opts.issueLookup;
  }

  async query(question: string): Promise<QueryResult> {
    if (typeof question !== "string") {
      throw new TypeError("KnowledgeService.query: question must be a string");
    }
    if (this.vectorIndex.size() === 0) {
      // 3286 AC-3: empty index + first sync in flight → warming-up copy; every
      // initial sync errored → sync-failed copy; anything else (no sources
      // configured, or a settled sync that indexed nothing) keeps the old copy.
      if (this.initialSyncPhase === "in-flight") {
        return { answer: WARMING_UP_ANSWER, citations: [] };
      }
      if (this.initialSyncPhase === "failed") {
        return { answer: SYNC_FAILED_ANSWER, citations: [] };
      }
      return { answer: NO_DOCUMENTS_ANSWER, citations: [] };
    }
    return this.answerWithKeyLookup(question);
  }

  /**
   * #3299 — the answer path with the exact-key leg in front of the vector
   * pipeline. A question that names no configured key takes the UNTOUCHED
   * branch: `retrieve()` → generator, byte-identical to today (AC-8 parity).
   * A named key is pinned FIRST (its indexed chunks, <= 3 passages in index
   * order) or live-fetched (one read-only fetch of exactly that issue) when
   * unindexed; the live leg is sequential with a whole-leg deadline; a key Jira
   * does not hand back (miss, error, or timeout) gets an honest answer naming
   * it — never a neighbouring ticket as a stand-in.
   */
  private async answerWithKeyLookup(question: string): Promise<QueryResult> {
    const namedKeys = this.issueLookup
      ? extractIssueKeys(question, this.issueLookup.projectKeys).slice(0, MAX_NAMED_KEYS)
      : [];
    if (namedKeys.length === 0) {
      // No key named: the plain, unchanged vector path.
      const hits = await this.retrieve(question);
      return this.generator(question, hits.map(toLlmChunk));
    }

    const pinned: LlmChunk[] = [];
    const missLines: string[] = [];
    const liveKeys: string[] = [];
    const factsLines: string[] = [];
    const metaFailLines: string[] = [];
    const legStart = this.now();

    for (const key of namedKeys) {
      const source = `jira:${key}`;
      // Named + indexed: pin its first passages, ahead of every vector hit.
      const indexed = this.vectorIndex.getChunksBySource(source);
      if (indexed.length > 0) {
        for (const c of indexed.slice(0, MAX_CHUNKS_PER_NAMED_SOURCE)) {
          const chunk: LlmChunk = {
            id: c.id,
            text: c.text,
            source: c.source,
            score: 1, // pinned by name, not by vector similarity
          };
          if (c.heading !== undefined) chunk.heading = c.heading;
          if (c.section !== undefined) chunk.section = c.section;
          pinned.push(chunk);
        }
        // #3307 — the pinned text is the 6-hourly indexed copy, but status is
        // the field that goes stale fastest, so ONE bounded live fetch of the
        // SAME key supplies a code-built facts line labelled live (the index
        // body text is never presented as current status). The fetch rides the
        // same sequential leg + deadline; a miss/error/timeout is honest and
        // the pin survives; "skipped" (no fetcher) adds no line at all.
        const facts = await this.fetchIssueLive(key, legStart);
        if (facts.status === "ok") {
          const line = renderIssueFactsLine(key, facts.meta);
          if (line) factsLines.push(line);
        } else if (facts.status === "miss" || facts.status === "timeout") {
          metaFailLines.push(keyMetaFailLine(key));
        }
        continue;
      }
      // Named + unindexed: one bounded live fetch of exactly that issue —
      // it supplies BOTH the pinned text and the #3307 facts line (one fetch,
      // never two).
      const fetched = await this.fetchIssueLive(key, legStart);
      if (fetched.status === "ok") {
        pinned.push(...fetched.chunks);
        liveKeys.push(key);
        const line = renderIssueFactsLine(key, fetched.meta);
        if (line) factsLines.push(line);
      } else if (fetched.status === "timeout") {
        missLines.push(keyTimeoutLine(key));
      } else if (fetched.status === "miss") {
        missLines.push(keyMissLine(key));
      }
      // "skipped" (no fetcher configured): no pin, no miss copy — falls back
      // to the vector answer rather than fabricating a not-found.
    }

    // Every named key missed (and at least one had a live leg): the honest
    // answer, naming each key with its reason. No generator call, no
    // citations, no vector-neighbour substitute (plan intent item 4).
    if (pinned.length === 0 && missLines.length > 0) {
      return { answer: missLines.join(" "), citations: [] };
    }

    const hits = await this.retrieve(question);
    // Pinned chunks LEAD; vector hits fill the remainder up to the SAME topK —
    // named chunks displace the vector tail, they never grow the context.
    const context = [...pinned, ...hits.map(toLlmChunk)].slice(0, this.topK);
    const result = await this.generator(question, context);

    let answer = result.answer;
    const prelude: string[] = [];
    if (liveKeys.length > 0) {
      prelude.push(
        `Answer includes ${liveKeys.join(", ")} fetched live from Jira just now ` +
          `(created too recently for the 6-hourly sync).`,
      );
    }
    if (factsLines.length > 0) prelude.push(factsLines.join(" "));
    if (missLines.length > 0) prelude.push(missLines.join(" "));
    if (metaFailLines.length > 0) prelude.push(metaFailLines.join(" "));
    if (prelude.length > 0) answer = `${prelude.join(" ")} ${answer}`;
    return { answer, citations: result.citations };
  }

  /**
   * One time-boxed read-only fetch of exactly `key`. Sequential leg with a
   * deadline: this fetch's budget is min(LIVE_FETCH_TIMEOUT_MS, leg time left),
   * so N slow fetches can never overshoot LIVE_LEG_DEADLINE_MS. Expiry, an
   * errored fetch, and an empty result are all honest misses (timeout / not
   * found) — the answer path never hangs on Jira (#3286 regression class).
   * The fetched text fills the context ONLY (<= 3 passages); it is NOT added
   * to the index — the next 6-hourly sync indexes it anyway.
   */
  private async fetchIssueLive(
    key: string,
    legStart: number,
  ): Promise<
    | { status: "ok"; chunks: LlmChunk[]; meta: IssueMeta | undefined }
    | { status: "miss" }
    | { status: "timeout" }
    | { status: "skipped" }
  > {
    const fetcher = this.issueLookup?.issueFetcher;
    if (!fetcher) return { status: "skipped" };

    const remaining = LIVE_LEG_DEADLINE_MS - (this.now() - legStart);
    if (remaining <= 0) return { status: "timeout" };
    const budget = Math.min(LIVE_FETCH_TIMEOUT_MS, remaining);

    let issue: LiveIssue | null;
    try {
      issue = await this.withTimeout(fetcher.fetchIssue(key), budget);
    } catch (err) {
      // Timed out, HTTP error, or network failure — all honest misses; only
      // the timeout expiry gets the timed-out copy.
      return {
        status: err instanceof Error && err.message === FETCH_TIMEOUT ? "timeout" : "miss",
      };
    }
    if (!issue) return { status: "miss" };

    // Mirror JiraSync's body assembly so live and indexed text match in shape.
    const body = [
      issue.key,
      issue.summary,
      issue.descriptionText,
      ...issue.commentTexts,
    ]
      .filter(Boolean)
      .join("\n\n");
    const passages = splitIntoPassages(body).slice(0, MAX_CHUNKS_PER_NAMED_SOURCE);
    const chunks: LlmChunk[] = passages.map((passage, i) => {
      const chunk: LlmChunk = {
        id: `live:${key}:${i}`,
        text: passage,
        source: `jira:${key}`,
        score: 1, // pinned by name, fetched live
      };
      if (issue && issue.summary) chunk.heading = issue.summary;
      return chunk;
    });
    // #3307 — the same single fetch carries the live metadata (if the fetcher
    // requested it); the caller renders the facts line, this never touches the
    // index.
    return { status: "ok", chunks, meta: issue.meta };
  }

  /** Reject with a timeout error if `p` does not settle within `ms`. */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(FETCH_TIMEOUT)), ms);
      p.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * 3286 Part A (AC-3): initial-sync lifecycle hooks. `startKnowledgeSources`
   * calls `noteInitialSyncStarted()` when the first boot sync is kicked off and
   * `noteInitialSyncSettled(allFailed)` once every initial sync has settled,
   * so `query()` can tell "warming up" and "sync failed" apart from "no
   * relevant information" while the index is empty.
   */
  noteInitialSyncStarted(): void {
    if (this.initialSyncPhase === "not-started") {
      this.initialSyncPhase = "in-flight";
    }
  }

  noteInitialSyncSettled(allFailed: boolean): void {
    this.initialSyncPhase = allFailed ? "failed" : "settled";
  }

  getInitialSyncPhase(): InitialSyncPhase {
    return this.initialSyncPhase;
  }

  /**
   * Recall v2 ranking pipeline (#1191). Returns the top-K `SearchResult`s the
   * generator answers from. The SAME path `query()` uses, exposed so the
   * standalone `eval:recall` harness measures the production ranking (not a
   * re-implementation). Pipeline order is load-bearing:
   *
   *   1. expandQuery   — widen the bi-encoder recall net for geo intent (L1)
   *   2. search(poolK) — widen pool only when rerank/cap need a deeper batch
   *   3. rerank        — cross-encoder scores the ORIGINAL question (L2, OFF by default)
   *   4. docPrior      — how-to-action doc-over-ticket prior (L4, ON by default; no-op off-intent)
   *   5. diversity cap — reshuffle so one source-type can't monopolize (L3)
   *   6. slice topK
   *
   * With all levers off this collapses to `search(question, topK)` — byte-identical
   * to the pre-#1191 behavior. SHIPPED defaults are expansion+cap ON, rerank OFF.
   */
  async retrieve(question: string): Promise<SearchResult[]> {
    const r = this.recall;
    const q = expandQuery(question, r.expansion);
    const widen = r.rerank.enabled || r.diversityCap.enabled;
    const poolK = widen ? Math.max(this.topK, r.candidatePoolSize) : this.topK;

    const pool = await this.vectorIndex.search(q, poolK);

    let ranked: SearchResult[] = pool;
    if (r.rerank.enabled) {
      // Cross-encoder scores the ORIGINAL question, not the expanded query.
      ranked = await rerank(question, pool, {
        ...r.rerank,
        candidatePool: r.rerank.candidatePool,
      });
    }

    // Lever 4 (#1197) — how-to-action doc-over-ticket prior. Cheap, always-on by
    // default, fires ONLY on how-to-action intent (the ORIGINAL question, like
    // rerank); controls / geo / already-grounded queries pass through unchanged.
    // Runs before the diversity cap so the cap shapes the prioritized order.
    ranked = applyDocPrior(question, ranked, {
      enabled: r.docPrior.enabled,
      bonus: r.docPrior.bonus,
      docSourceTypes: r.docPrior.docSourceTypes,
    });

    const capped = applyDiversityCap(ranked, this.topK, {
      enabled: r.diversityCap.enabled,
      maxPerSourceType: r.diversityCap.maxPerSourceType,
    });
    return capped.slice(0, this.topK);
  }

  async indexFile(absolutePath: string): Promise<void> {
    if (typeof absolutePath !== "string" || absolutePath.length === 0) {
      throw new TypeError("KnowledgeService.indexFile: absolutePath must be a non-empty string");
    }
    const chunks = await this.ingest(absolutePath);
    if (chunks.length === 0) return;
    await this.vectorIndex.add(chunks);
    for (const c of chunks) this.indexedSources.add(c.source);
  }

  /**
   * Index pre-built chunks directly (no file read, no parser dispatch). Useful
   * for tests, format-parity assertions, and callers that already hold parsed
   * `{ id?, text, source, heading?, section? }` objects. Each chunk's `source`
   * counts toward `documentCount` once. `id` is optional — VectorIndex will
   * synthesize one from `(source, text)` if omitted.
   */
  async indexChunks(chunks: IndexChunk[]): Promise<void> {
    if (!Array.isArray(chunks)) {
      throw new TypeError("KnowledgeService.indexChunks: chunks must be an array");
    }
    if (chunks.length === 0) return;
    await this.vectorIndex.add(chunks);
    for (const c of chunks) this.indexedSources.add(c.source);
  }

  /**
   * Index a Confluence page. The page's `source` field is treated as the canonical
   * identifier (e.g. `"confluence:page-001"`); any prior chunks with the same
   * `source` are removed first so a re-sync replaces (rather than duplicates) the
   * previous version. Title becomes `heading`; spaceKey becomes `section`.
   */
  async indexConfluencePage(page: ConfluencePageInput): Promise<void> {
    if (!page || typeof page !== "object") {
      throw new TypeError("KnowledgeService.indexConfluencePage: page must be an object");
    }
    if (typeof page.id !== "string" || page.id.length === 0) {
      throw new TypeError("KnowledgeService.indexConfluencePage: page.id must be a non-empty string");
    }
    if (typeof page.body !== "string") {
      throw new TypeError("KnowledgeService.indexConfluencePage: page.body must be a string");
    }
    const source =
      typeof page.source === "string" && page.source.length > 0
        ? page.source
        : `confluence:${page.id}`;

    // Replace-on-resync: drop any prior version under the same source first so
    // we don't accumulate stale chunks (US-06's removeBySource is the same
    // replace-on-resync path).
    await this.vectorIndex.removeBySource(source);

    const text = page.body.trim();

    // Passage-chunk the page (#1189): embed each bounded passage as its own
    // vector so the relevant passage ranks high, instead of one diluted +
    // truncated whole-page vector. removeBySource above already cleared all prior
    // passages (they share this `source`), so re-sync replaces rather than
    // accumulates. A non-empty body ALWAYS yields >= 1 passage, so
    // `passages.length === 0` is reached ONLY for an empty/whitespace body —
    // which we treat as a delete (mirrors the prior empty-body guard).
    const passages = splitIntoPassages(text);
    if (passages.length === 0) {
      this.indexedSources.delete(source);
      return;
    }

    const heading =
      typeof page.title === "string" && page.title.length > 0 ? page.title : undefined;
    const section =
      typeof page.spaceKey === "string" && page.spaceKey.length > 0 ? page.spaceKey : undefined;

    const passageChunks: IngestChunk[] = passages.map((passage) => {
      const chunk: IngestChunk = { text: passage, source };
      if (heading !== undefined) chunk.heading = heading;
      if (section !== undefined) chunk.section = section;
      return chunk;
    });

    await this.vectorIndex.add(passageChunks);
    this.indexedSources.add(source);
  }

  /** Return the number of chunks currently indexed under `source`. */
  getChunkCountForSource(source: string): number {
    return this.vectorIndex.getChunkCountForSource(source);
  }

  /**
   * Remove a file's chunks from the in-memory index. The path is resolved against
   * whatever the ingest pipeline used as `chunk.source` (absolute path via
   * `path.resolve`). No-op if the source isn't currently indexed.
   */
  async unindexFile(absolutePath: string): Promise<void> {
    if (typeof absolutePath !== "string" || absolutePath.length === 0) {
      throw new TypeError("KnowledgeService.unindexFile: absolutePath must be a non-empty string");
    }
    // chunk.source is set by the ingestion layer to path.resolve(filePath).
    // Resolve here too so callers passing a non-resolved path still hit.
    const path = require("node:path") as typeof import("node:path");
    const resolved = path.resolve(absolutePath);
    await this.vectorIndex.removeBySource(resolved);
    this.indexedSources.delete(resolved);
  }

  getStatus(): ServiceStatus {
    return {
      documentCount: this.indexedSources.size,
      uptimeSeconds: Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)),
    };
  }
}
