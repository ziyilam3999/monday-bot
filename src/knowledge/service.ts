import { ingestFile, Chunk as IngestChunk } from "../ingestion/ingest";
import { VectorIndex, SearchResult } from "../index/vectorIndex";
import { generateAnswer, Chunk as LlmChunk, Citation } from "../llm/generate";
import {
  FolderWatcher,
  FolderWatcherOptions,
} from "../watcher/folderWatcher";

const DEFAULT_TOP_K = 5;
const NO_DOCUMENTS_ANSWER =
  "I couldn't find any relevant information in the indexed documents to answer this question.";

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
  watcherAlive: boolean;
  uptimeSeconds: number;
}

export interface AnswerGenerator {
  (question: string, chunks: LlmChunk[]): Promise<{ answer: string; citations: Citation[] }>;
}

export interface FileIngestor {
  (absolutePath: string): Promise<IngestChunk[]>;
}

export interface WatcherFactory {
  (
    dir: string,
    callbacks: {
      onAdd: (p: string) => Promise<void>;
      onChange: (p: string) => Promise<void>;
      onUnlink: (p: string) => Promise<void>;
      onError?: (e: Error) => void;
    },
    opts?: FolderWatcherOptions,
  ): { start(): void; close(): void; isAlive(): boolean };
}

export interface KnowledgeServiceOptions {
  index?: VectorIndex;
  ingest?: FileIngestor;
  generator?: AnswerGenerator;
  topK?: number;
  now?: () => number;
  /** Inject a watcher factory for tests. Defaults to `FolderWatcher`. */
  watcherFactory?: WatcherFactory;
  /** Forwarded to the watcher (e.g. debounceMs). Defaults `{}`. */
  watcherOptions?: FolderWatcherOptions;
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

const defaultWatcherFactory: WatcherFactory = (dir, callbacks, opts) =>
  new FolderWatcher(dir, callbacks, opts);

export class KnowledgeService {
  private readonly vectorIndex: VectorIndex;
  private readonly ingest: FileIngestor;
  private readonly generator: AnswerGenerator;
  private readonly topK: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly indexedSources = new Set<string>();
  private readonly watcherFactory: WatcherFactory;
  private readonly watcherOptions: FolderWatcherOptions;
  private readonly watchers: Array<{ start(): void; close(): void; isAlive(): boolean }> = [];

  constructor(opts: KnowledgeServiceOptions = {}) {
    this.vectorIndex = opts.index ?? new VectorIndex();
    this.ingest = opts.ingest ?? ingestFile;
    this.generator = opts.generator ?? generateAnswer;
    this.topK = opts.topK ?? DEFAULT_TOP_K;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.watcherFactory = opts.watcherFactory ?? defaultWatcherFactory;
    this.watcherOptions = opts.watcherOptions ?? {};
  }

  async query(question: string): Promise<QueryResult> {
    if (typeof question !== "string") {
      throw new TypeError("KnowledgeService.query: question must be a string");
    }
    if (this.vectorIndex.size() === 0) {
      return { answer: NO_DOCUMENTS_ANSWER, citations: [] };
    }
    const hits = await this.vectorIndex.search(question, this.topK);
    const chunks = hits.map(toLlmChunk);
    return this.generator(question, chunks);
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
    // we don't accumulate stale chunks (US-06's removeBySource is the same path
    // the file watcher uses on change events).
    await this.index.removeBySource(source);

    const text = page.body.trim();
    if (text.length === 0) {
      this.indexedSources.delete(source);
      return;
    }

    const chunk: IngestChunk = { text, source };
    if (typeof page.title === "string" && page.title.length > 0) chunk.heading = page.title;
    if (typeof page.spaceKey === "string" && page.spaceKey.length > 0) chunk.section = page.spaceKey;

    await this.index.add([chunk]);
    this.indexedSources.add(source);
  }

  /** Return the number of chunks currently indexed under `source`. */
  getChunkCountForSource(source: string): number {
    return this.index.getChunkCountForSource(source);
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
    await this.index.removeBySource(resolved);
    this.indexedSources.delete(resolved);
  }

  /**
   * Start watching `dir` for new/changed/deleted files and keep the in-memory
   * index in sync. Returns immediately; events are processed asynchronously.
   * Safe to call multiple times with different directories.
   */
  watchFolder(dir: string): void {
    if (typeof dir !== "string" || dir.length === 0) {
      throw new TypeError("KnowledgeService.watchFolder: dir must be a non-empty string");
    }
    const watcher = this.watcherFactory(
      dir,
      {
        onAdd: async (p) => {
          try {
            await this.indexFile(p);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`KnowledgeService watcher onAdd failed for ${p}:`, err);
          }
        },
        onChange: async (p) => {
          try {
            await this.unindexFile(p);
            await this.indexFile(p);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`KnowledgeService watcher onChange failed for ${p}:`, err);
          }
        },
        onUnlink: async (p) => {
          try {
            await this.unindexFile(p);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`KnowledgeService watcher onUnlink failed for ${p}:`, err);
          }
        },
      },
      this.watcherOptions,
    );
    watcher.start();
    this.watchers.push(watcher);
  }

  /** Stop all watchers. Useful in tests and on shutdown. */
  stopWatching(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // best-effort
      }
    }
    this.watchers.length = 0;
  }

  getStatus(): ServiceStatus {
    return {
      documentCount: this.indexedSources.size,
      watcherAlive: this.watchers.some((w) => w.isAlive()),
      uptimeSeconds: Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)),
    };
  }
}
