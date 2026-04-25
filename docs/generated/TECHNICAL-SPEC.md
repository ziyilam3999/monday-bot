---
schemaVersion: "1.0.0"
lastUpdated: "2026-04-25T16:14:26.405Z"
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
