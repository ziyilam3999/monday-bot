---
schemaVersion: "1.0.0"
lastUpdated: "2026-04-26T05:14:39.001Z"
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
- `KnowledgeService.search(query: string): Promise<KnowledgeResult[]>`: searches indexed knowledge base
- `KnowledgeService.index(doc: KnowledgeDocument): Promise<void>`: adds a document to the knowledge store
- `KnowledgeService.delete(id: string): Promise<void>`: removes a document by id from the knowledge store

### data-models

- `KnowledgeDocument`: persisted shape with at minimum `id: string`, `content: string`, and metadata fields
- `KnowledgeResult`: wire-format response shape returned by `search`, wrapping `KnowledgeDocument` with a relevance score

### invariants

- `KnowledgeService.search` MUST return results sorted by descending relevance score
- `KnowledgeService.index` MUST be idempotent on `id` (re-indexing same id overwrites, no duplicates)
- `KnowledgeService.delete` MUST NOT throw if the given `id` does not exist
- `src/knowledge/index.ts` MUST re-export all public surfaces of `src/knowledge/service.ts`

### test-surface

- `tests/knowledge.test.ts`: new file, 123 lines covering `KnowledgeService` index / search / delete behaviour
- Test file matched by Jest pattern `--testPathPattern=knowledge`; MUST remain passing (AC-04 ratchet)
