# Changelog

All notable changes to monday-bot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0](https://github.com/ziyilam3999/monday-bot/compare/v0.2.0...v0.3.0) (2026-04-20)

Embeddings + vector index + persistence — US-03 shipped. Monday now turns text
into 384-dim semantic vectors via a CPU-local sentence-transformer and answers
"which of these chunks is most similar to this query" via brute-force cosine
similarity. This is the retrieval foundation for US-04 (LLM answer generation).

### Features

- **embeddings (US-03)**: `embed(text) → Promise<number[]>` via
  `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`, 384-dim)
  ([#21](https://github.com/ziyilam3999/monday-bot/pull/21))
  - CPU-only, no remote API, no API key
  - Lazy-loads the ONNX pipeline on first call (~23MB download, cached to
    `~/.cache/huggingface/`); same instance reused across calls
  - Promise-cached constructor races handled — concurrent cold-start calls
    do not double-load the model
- **vector index (US-03)**: `VectorIndex` class —
  `add(chunks[])` / `search(query, k)` / `save(dir)` / `load(dir)` /
  `remove(id)`
  - Holds `Chunk[]` + `number[][]` in memory; cosine brute-force retrieval
    (O(n·d) — fine at PRD single-process scale)
  - Persistence: single-file `index.json` at `save(dir)`. Model-id stamped
    in the file so `load()` fails fast on model mismatch (belt-and-braces
    for US-04)
  - Auto-generates sha1 chunk IDs for chunks added without an explicit id
    (US-02 Chunks don't carry IDs; AC-04 requires `remove(id)`)
- **jest ESM workaround**: `@xenova/transformers` is ESM-only but monday-bot
  is CJS + ts-jest. Added a deterministic hash-based stub at
  `tests/__stubs__/xenova-transformers.js` wired via `jest.config.js`
  `moduleNameMapper`. Tests exercise VectorIndex logic + ranking structure;
  real model is exercised by the US-03 AC inline commands.
- **jest suite**: 22 specs total (4 new for embed, 6 new for vectorIndex) —
  all pass. 5/5 US-03 ACs PASS trusted via `forge_evaluate`.

### Known follow-ups (non-blocking)

PR #21 review found 0 bugs in iteration 1 and 5 enhancements, filed as issues:

- [#22](https://github.com/ziyilam3999/monday-bot/issues/22) `VectorIndex.load`
  should assert `chunks.length === vectors.length`
- [#23](https://github.com/ziyilam3999/monday-bot/issues/23) duplicate-id
  silent-skip hides hash collisions — add debug log / strict mode
- [#24](https://github.com/ziyilam3999/monday-bot/issues/24) add vector
  byte-equality or multi-chunk ranking assertion to save/load round-trip test
- [#25](https://github.com/ziyilam3999/monday-bot/issues/25) add clarifying
  comment to `tests/__stubs__/xenova-transformers.js`
- [#26](https://github.com/ziyilam3999/monday-bot/issues/26) expose
  `_resetExtractorForTests()` for US-11 model hot-swap

## [0.2.0](https://github.com/ziyilam3999/monday-bot/compare/v0.1.0...v0.2.0) (2026-04-20)

Document ingestion pipeline — US-02 shipped. Monday can now read TXT, MD, PDF,
and DOCX files and turn them into structured chunks with source and heading
metadata. This is the foundation layer for US-03 (embeddings) and US-04 (LLM
retrieval).

### Features

- **ingestion (US-02)**: `ingestFile(path) → Promise<Chunk[]>` routes by
  extension to dedicated parsers
  ([#8](https://github.com/ziyilam3999/monday-bot/pull/8))
  - **TXT**: paragraph-split on blank lines, one chunk per paragraph
  - **Markdown**: heading-aware via `#`/`##`/`###` line scan; each section
    becomes a chunk with `heading` + `section` metadata. Code fences (```
    and `~~~`) are respected — heading-like lines inside fenced blocks are
    NOT promoted
  - **PDF**: `pdfjs-dist@3.11.174` (legacy CJS build) — one chunk per page,
    `doc.destroy()` called in a `finally` block so worker resources always
    release
  - **DOCX**: `mammoth` raw-text extraction, paragraph-split
  - `UnsupportedFileTypeError` thrown on unknown extensions (only `.txt`,
    `.md`, `.pdf`, `.docx` are accepted — `.markdown` is deliberately
    rejected to keep the contract tight)
  - Empty/whitespace-only chunks filtered at the router level
- **test fixtures**: 4 sample files (`sample.{txt,md,pdf,docx}`) plus a
  generator script at `scripts/generate-test-fixtures.js` using `pdfkit` +
  `docx` libraries so fixtures can be regenerated deterministically
- **jest suite**: 12 specs total (6 new for ingestion) — all pass

### Bug Fixes

PR #8 review iteration 1 flagged 3 bugs, all fixed in iteration 2 before merge:

- PDF parser no longer leaks `pdfjs` worker resources if page extraction
  throws mid-loop
- Markdown parser correctly ignores `#` lines inside fenced code blocks
  (previously they were promoted to real headings and split the block)
- `.markdown` extension alias removed — was accepted silently while the
  error message claimed it wasn't supported

### Known follow-ups (non-blocking)

PR #8 review found 0 bugs in iteration 2 after fixes and 12 enhancements,
filed as issues:

- [#9](https://github.com/ziyilam3999/monday-bot/issues/9) strip BOM from
  TXT/MD inputs
- [#10](https://github.com/ziyilam3999/monday-bot/issues/10) surface mammoth
  warnings from DOCX parser
- [#11](https://github.com/ziyilam3999/monday-bot/issues/11) support
  setext-style MD headings (`===` / `---`)
- [#12](https://github.com/ziyilam3999/monday-bot/issues/12) replace
  `require()` with ES import for pdfjs-dist
- [#13](https://github.com/ziyilam3999/monday-bot/issues/13) pin pdfjs-dist
  exact version or use `~3.11.0`
- [#14](https://github.com/ziyilam3999/monday-bot/issues/14) path validation
  for future Slack/Confluence ingestion
- [#15](https://github.com/ziyilam3999/monday-bot/issues/15) inject parser
  map for easier router unit tests
- [#16](https://github.com/ziyilam3999/monday-bot/issues/16) tighten
  UnsupportedFileTypeError test to also assert error name
- [#17](https://github.com/ziyilam3999/monday-bot/issues/17) streaming parse
  to avoid OOM on large PDFs (free-tier ARM target)
- [#18](https://github.com/ziyilam3999/monday-bot/issues/18) update fixture
  PDF body text — references `pdf-parse` not `pdfjs-dist`
- [#19](https://github.com/ziyilam3999/monday-bot/issues/19) wrap pdfjs
  `PasswordException` with friendly error message
- [#20](https://github.com/ziyilam3999/monday-bot/issues/20) MD parser sets
  `heading` and `section` to identical value — diverge or collapse

## [0.1.0](https://github.com/ziyilam3999/monday-bot/releases/tag/v0.1.0) (2026-04-20)

First scaffolded release. Establishes the TypeScript project skeleton, jest test
suite, secrets-validation entrypoint, and CI workflow. No functional bot
behavior yet — this is the foundation for stories US-02..US-13.

### Features

- **scaffolding (US-01)**: TypeScript project with secrets validation and build
  pipeline ([#1](https://github.com/ziyilam3999/monday-bot/pull/1))
  - `validateEnv()` rejects missing or empty `SLACK_BOT_TOKEN` and
    `SLACK_APP_TOKEN`, throwing `MissingEnvVarError` with a human-readable
    message that names every missing variable
  - jest suite (4 specs) covers happy path, single missing var, empty string,
    multiple missing
  - `tsc` compiles `src/` to `dist/`; `node dist/index.js` exits 1 with a
    friendly error on missing env (no stack traces)
  - `.gitignore` excludes `.env`, `node_modules/`, `dist/`, `.forge/`,
    `.ai-workspace/`, `.claude/`

### Miscellaneous

- **ci**: initial repo setup with CI matrix (ubuntu + windows × Node 20),
  build/test gates, and Conventional Commits validator on push

### Known follow-ups (non-blocking)

PR #1 stateless review found 0 bugs and 6 minor enhancements, filed as issues:

- [#2](https://github.com/ziyilam3999/monday-bot/issues/2) `validateEnv` should
  trim returned token values
- [#3](https://github.com/ziyilam3999/monday-bot/issues/3) Redundant
  empty-string check in filter
- [#4](https://github.com/ziyilam3999/monday-bot/issues/4) `main()` re-throws
  non-env errors as raw stack traces (folds into US-10 Graceful Errors)
- [#5](https://github.com/ziyilam3999/monday-bot/issues/5) `main()` runs as
  module side-effect — hard to import for tests
- [#6](https://github.com/ziyilam3999/monday-bot/issues/6) `jest.config.js`
  uses legacy ts-jest preset form
- [#7](https://github.com/ziyilam3999/monday-bot/issues/7) `tsconfig` excludes
  `tests/` — type errors there only surface at runtime

### Bootstrap-era CI badges

Two commits show red CI on master that are explained-not-broken artifacts of
the bootstrap and do not affect ongoing CI health:

- `9d5fc6f` (initial repo setup): `actions/setup-node@v4 cache: npm` failed
  because no `package-lock.json` existed on master at that commit. Fixed
  permanently by US-01 merging the lock file into master.
- `257f86b` (squash merge of PR #1): Conventional Commits validator failed
  because the squash subject was `US-01: scaffold TypeScript project with
  secrets validation (#1)` — original commit subject, no `feat:` prefix.
  Fixed permanently by setting GitHub's
  `squash_merge_commit_title=PR_TITLE` so future squashes use the
  conv-commits-formatted PR title.

From v0.2.0 onward, CI is expected green on every master push.
