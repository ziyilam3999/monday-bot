---
schemaVersion: "1.0.0"
lastUpdated: "2026-04-26T10:54:08.210Z"
stories:
  - id: "US-01"
    lastUpdated: "2026-04-25T16:06:52.426Z"
    lastGitSha: "484cee16abbc983923c66324f60701179a9d451b"
  - id: "US-02"
    lastUpdated: "2026-04-25T16:10:06.995Z"
    lastGitSha: "484cee16abbc983923c66324f60701179a9d451b"
  - id: "US-03"
    lastUpdated: "2026-04-25T16:12:38.185Z"
    lastGitSha: "484cee16abbc983923c66324f60701179a9d451b"
  - id: "US-04"
    lastUpdated: "2026-04-25T16:14:26.405Z"
    lastGitSha: "484cee16abbc983923c66324f60701179a9d451b"
  - id: "US-05"
    lastUpdated: "2026-04-26T05:14:39.001Z"
    lastGitSha: "9fecce531c1a7445a071190299fdafa15f98e5b3"
  - id: "US-06"
    lastUpdated: "2026-04-26T10:54:08.210Z"
    lastGitSha: "6fa4f9301df97dd0372bf915c6c64fb157c64456"
---

## story: US-01

### api-contracts

(none)

### data-models

(none)

### invariants

(none)

### test-surface

(none)







## story: US-02

### api-contracts

(none)

### data-models

(none)

### invariants

- `anthropicClient` must compile without TypeScript errors under `tsc`
- `anthropicClient` changes must not break ingestion test suite (`jest --testPathPattern=ingestion`)

### test-surface

- Existing ingestion test suite (`jest --testPathPattern=ingestion`) used as regression gate for `anthropicClient` changes






## story: US-03

### api-contracts

(none)

### data-models

(none)

### invariants

- Vector embeddings MUST have dimension 384
- Top similarity search result for vpn-related query MUST be `vpn-guide.txt`
- Index MUST reload successfully after persistence
- Deleted chunks MUST NOT appear in search results

### test-surface

- `tests/embed.test.ts`: covers embedding dimension invariant
- `tests/embed-cache.test.ts`: covers embedding cache behaviour
- `tests/vectorIndex.test.ts`: covers index reload and deletion correctness





## story: US-04

### api-contracts

(none)

### data-models

(none)

### invariants

(none)

### test-surface

(none)




## story: US-05

### api-contracts

- `KnowledgeService`: new public class exported from `src/knowledge/index.ts`
- `KnowledgeService.query(question: string): Promise<QueryResult>`: orchestrates vector search + LLM answer generation against the indexed corpus
- `KnowledgeService.indexFile(absolutePath: string): Promise<void>`: ingests a single file from disk into the in-memory vector index
- `KnowledgeService.getStatus(): ServiceStatus`: returns synchronous service health snapshot

### data-models

- `QueryResult`: `{ answer: string; citations: Citation[] }` — `Citation` shape is reused from `src/llm/generate.ts` (US-04)
- `ServiceStatus`: `{ documentCount: number; watcherAlive: boolean; uptimeSeconds: number }`
- `KnowledgeServiceOptions`: optional DI surface — `{ index?, ingest?, generator?, topK?, now? }` — used by tests to inject stubs

### invariants

- `KnowledgeService.query` MUST short-circuit to a fixed no-documents answer with `citations: []` when the index is empty (no embedding, no generator call)
- `KnowledgeService.query` MUST throw `TypeError` when `question` is not a string
- `KnowledgeService.indexFile` MUST throw `TypeError` when `absolutePath` is not a non-empty string
- `KnowledgeService.indexFile` MUST be a no-op when the ingestor returns zero chunks (no index mutation)
- `KnowledgeService.getStatus().documentCount` counts unique source files, NOT individual chunks
- `KnowledgeService.getStatus().uptimeSeconds` is monotonic non-negative seconds since constructor, derived from the injected `now()` clock
- `KnowledgeService.getStatus().watcherAlive` is `false` in this slice — wired by US-06 (file watcher)
- The facade MUST stay platform-agnostic: no Slack-specific types appear in its in/out shapes
- `src/knowledge/index.ts` MUST re-export the public class and types

### test-surface

- `tests/knowledge.test.ts`: covers `query` / `indexFile` / `getStatus` behaviour across empty-index, end-to-end index→query, source-file dedupe, type guards, and clock-driven uptime
- Matched by Jest pattern `--testPathPattern=knowledge`; MUST remain passing (AC-04 ratchet)



## story: US-06

### api-contracts

- `FolderWatcher.start`: begins watching a directory; accepts `FolderWatcherOptions` and `FolderWatcherCallbacks`, returns void
- `FolderWatcher.close`: stops the watcher and releases resources
- `FolderWatcher.isAlive`: returns boolean indicating whether the watcher is currently active
- `WatcherEvent`: exported value enumerating event kinds (add, change, unlink, error)

### data-models

- `FolderWatcherOptions`: shape `{ debounceMs?: number, existsSync?: fn, filter?: fn, watch?: fn }` — all fields optional
- `FolderWatcherCallbacks`: shape `{ onAdd, onChange, onUnlink, onError }` — all fields are event-handler functions

### invariants

- `FolderWatcher.isAlive` MUST return `false` after `close()` is called
- `FolderWatcher.isAlive` MUST return `true` between a successful `start()` and any `close()` call
- `FolderWatcherCallbacks.onError` MUST be invoked instead of throwing when a watch error occurs
- Debounce interval defined by `FolderWatcherOptions.debounceMs` MUST delay repeated callbacks for the same path

### test-surface

- `tests/watcher.test.ts`: new file, 374 lines; covers `FolderWatcher` start/close lifecycle, `isAlive` state transitions, debounce behaviour, filter predicate, and all four callback paths
