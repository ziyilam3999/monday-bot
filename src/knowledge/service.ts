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

// Raised 5 -> 12 (#1189): passage-chunking can fill several top slots with
// passages from the same doc, so a wider window leaves room for the relevant
// passage AND cross-doc coverage. `opts.topK` still overrides per-service.
const DEFAULT_TOP_K = 12;
const NO_DOCUMENTS_ANSWER =
  "I couldn't find any relevant information in the indexed documents to answer this question.";

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

  constructor(opts: KnowledgeServiceOptions = {}) {
    this.vectorIndex = opts.index ?? new VectorIndex();
    this.ingest = opts.ingest ?? ingestFile;
    this.generator = opts.generator ?? generateAnswer;
    this.topK = opts.topK ?? DEFAULT_TOP_K;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.recall = resolveRecall(opts.recall);
  }

  async query(question: string): Promise<QueryResult> {
    if (typeof question !== "string") {
      throw new TypeError("KnowledgeService.query: question must be a string");
    }
    if (this.vectorIndex.size() === 0) {
      return { answer: NO_DOCUMENTS_ANSWER, citations: [] };
    }
    const hits = await this.retrieve(question);
    const chunks = hits.map(toLlmChunk);
    return this.generator(question, chunks);
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
