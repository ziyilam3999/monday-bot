# Changelog

All notable changes to monday-bot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.7](https://github.com/ziyilam3999/monday-bot/compare/v0.4.6...v0.4.7) (2026-04-26)

### Bug Fixes

* anthropicClient one-shot warn for malformed credentials (#65)
* generate.ts log structured signal for empty model response (#66)

### Miscellaneous

* backfill TECHNICAL-SPEC + ADR INDEX for US-01..US-04 (#67)

## [0.4.6](https://github.com/ziyilam3999/monday-bot/compare/v0.4.5...v0.4.6) (2026-04-25)

### Miscellaneous

- **chore(polish): ship-review rollup v0.4.6** (#61) — bundles four small ship-review enhancements:
  - **#44** `fix(generate)`: empty model text (tool-use / refusal blocks only) now falls through to `NO_CONTEXT_ANSWER` with empty citations instead of an empty Slack message.
  - **#45** `fix(anthropicClient)`: `readOAuthToken` distinguishes `SyntaxError` from `ENOENT`/`EACCES` — malformed JSON now logs at warn level so operators see the misconfiguration; missing/unreadable creds still silent fall-through.
  - **#58** `test(embed-cache)`: rename `pipelineInvocations` → `mockPipelineInvocations` for `babel-plugin-jest-hoist` forward-compat.
  - **#59** `fix(embed)`: rephrase `_resetExtractorForTests()` NODE_ENV gate error away from "Set NODE_ENV=test to call it" footgun. New message describes the constraint without suggesting a worse fix.

3 follow-up enhancements filed: #62 (one-shot warn), #63 (deeper jest mock refactor), #64 (refusal-block observability).

## [0.4.5](https://github.com/ziyilam3999/monday-bot/compare/v0.4.4...v0.4.5) (2026-04-25)

### Bug Fixes

- **`parseDocx` logs mammoth `result.messages` when `MONDAY_DEBUG=1`** so conversion warnings (ignored elements, etc.) surface during debugging instead of silent discard. Closes #10. (#60)
- **`parseMarkdown` diverges `heading` and `section`**: `heading` tracks the nearest heading at any level (where the chunk lives), `section` tracks only the most recent H1 (which top-level group). Setext rule: `===` underline → H1 (updates section), `---` → H2 (heading only). Closes #20. (#60)

### Closed without code change

- **#14** (CORPUS_ROOT path validation) — deferred per its own forward-looking text; revisit when US-07/US-08 expose external-source ingestion.
- **#15** (parser-map injection for router tests) — deferred; current 4-parser surface is fine with `jest.mock()`.

## [0.4.4](https://github.com/ziyilam3999/monday-bot/compare/v0.4.3...v0.4.4) (2026-04-25)

### Bug Fixes

- **`_resetExtractorForTests()` gated by `NODE_ENV === "test"`.** Production callers that import the test seam by mistake now get a clear error instead of silently wiping the embedding cache. Closes #35. (#57)
- **New `tests/embed-cache.test.ts` proves cache lifecycle is real** by mocking `@xenova/transformers`, counting pipeline-builder invocations, and asserting cache hit on the second call + cache miss after reset. Plus a third test pins the NODE_ENV gate from the test side. Net +3 jest tests (43 → 46). Closes #36. (#57)

### Closed without code change

- **#37 (per-chunk duplicate-id warn → per-run summary counter)** closed as deferred. Issue text explicitly marks it as forward-looking — fine at PRD scale, will revisit at US-04/US-06 corpus expansion when duplicates become expected.

## [0.4.3](https://github.com/ziyilam3999/monday-bot/compare/v0.4.2...v0.4.3) (2026-04-25)

### Bug Fixes

- **`main()` catches all errors with a friendly one-line message + `exit 1`** instead of re-throwing as a raw Node stack trace. Set `MONDAY_DEBUG=1` to print the stack — preserves debugging escape hatch. Closes #4. (#56)
- **`tsconfig.test.json` covers `tests/`** plus a new `npm run typecheck` script that runs both src and test passes. Test files are now type-checked; the AC-01 `tsc --noEmit` against the default config remains green. Closes #7. (#56)

## [0.4.2](https://github.com/ziyilam3999/monday-bot/compare/v0.4.1...v0.4.2) (2026-04-25)

### Bug Fixes

- **pdfjs-extractor: narrow `doc` variable type** via `let doc!: Awaited<typeof loadingTask.promise>;` instead of `let doc;` (implicit `any`). Closes #53. (#55)
- **pdfjs-extractor: add regression test for PasswordException discriminator.** Mocks pdfjs to throw `name === "PasswordException"` and asserts `parsePdf` rethrows the friendly `<filePath> is password-protected` form. Locks the contract against silent renames in pdfjs upgrades. Closes #54. (#55)

## [0.4.1](https://github.com/ziyilam3999/monday-bot/compare/v0.4.0...v0.4.1) (2026-04-25)

### Bug Fixes

- **pdfjs PasswordException wrapped with friendly error.** `parsePdf` now detects `err.name === "PasswordException"` from pdfjs and rethrows as `Error('<filePath> is password-protected')` so encrypted PDFs surface a usable message instead of pdfjs's internal stack. Closes #19. (#52)
- **`ANTHROPIC_MODEL` env override accepted.** Makes the LLM model configurable per-run without code changes. Closes #18. (#51)
- **`EXPIRY_BUFFER_MS` extracted as named constant.** Clarifies intent at the API-key fallback site. Closes #17. (#50)
- **`node:os` mock added for deterministic API-key fallback test.** Stops the test reading the real homedir. (#49)
- **SDK stub request shape validated.** Catches drift in test harness assertions. (#48)

## [0.4.0](https://github.com/ziyilam3999/monday-bot/compare/v0.3.4...v0.4.0) (2026-04-21)

US-04 — Monday can now answer team questions using an LLM, citing only
the retrieval chunks it was given. Ships the Anthropic SDK wiring, the
credential-resolution chain (OAuth-first, API-key fallback), and a
stubbed jest harness so unit tests never make network calls.

### Features

- **llm**: `generateAnswer(question, chunks)` calls Claude Haiku 4.5
  with a numbered-context prompt and returns `{ answer, citations }`.
  Empty-chunks short-circuits to a deterministic "couldn't find"
  response without invoking the SDK, so US-02/03 retrieval misses
  never fabricate (closes US-04,
  [#41](https://github.com/ziyilam3999/monday-bot/pull/41))
- **llm**: OAuth-first `getClient()` reads `~/.claude/.credentials.json`
  with a 5-minute expiry buffer, falls through to
  `ANTHROPIC_API_KEY`, and throws a single error message naming both
  paths when neither resolves. `resetClient()` exported for credential
  rotation in long-running processes (US-08/US-13).

### Bug Fixes

- **ingestion**: replace `require()` with ES import for `pdfjs-dist`
  so the TypeScript build picks up the legacy bundle cleanly
  ([#38](https://github.com/ziyilam3999/monday-bot/pull/38))
- **ingestion**: pin `pdfjs-dist` to exact `3.11.174` to stop
  transitive upgrades from breaking the parser
  ([#39](https://github.com/ziyilam3999/monday-bot/pull/39))
- **tests**: drop dead `pdf-parse` reference in the PDF fixture body
  ([#40](https://github.com/ziyilam3999/monday-bot/pull/40))

## [0.3.4](https://github.com/ziyilam3999/monday-bot/compare/v0.3.3...v0.3.4) (2026-04-20)

US-03 polish — fold three non-blocking enhancements from the PR #21
ship-review into a small chore PR.

### Miscellaneous

- **index**: `VectorIndex.add()` emits a `console.warn` when skipping a
  duplicate chunk id so callers see an observability signal instead of
  silent no-op re-indexing ([#34](https://github.com/ziyilam3999/monday-bot/pull/34),
  closes [#23](https://github.com/ziyilam3999/monday-bot/issues/23))
- **tests**: new jest spec asserts that `search()` ranking order AND
  per-result scores are preserved across a `VectorIndex.save()` plus
  fresh `VectorIndex.load()` round-trip. Catches future regressions
  where JSON serialization could drift vector values (float precision
  loss, array truncation, quantization) (closes
  [#24](https://github.com/ziyilam3999/monday-bot/issues/24))
- **embeddings**: expose `_resetExtractorForTests()` that clears the
  module-level `pipelinePromise` cache. Enables future tests
  (notably US-11 model-swap scenarios) to re-initialize the pipeline
  without tearing down the whole test process. Named with a leading
  underscore to signal test-only intent (closes
  [#26](https://github.com/ziyilam3999/monday-bot/issues/26))
- **tests**: 3 new jest specs covering the duplicate-id warn path,
  ranking-preservation across save/load, and the reset-and-re-embed
  happy path (33/33 pass)

### Known follow-ups (non-blocking)

PR #34 review found 0 bugs and 3 enhancements, filed as issues:

- [#35](https://github.com/ziyilam3999/monday-bot/issues/35) gate
  `_resetExtractorForTests` behind `NODE_ENV` or move to a
  test-helpers module for stronger isolation
- [#36](https://github.com/ziyilam3999/monday-bot/issues/36)
  strengthen the reset spec to observe a cache-miss side effect
- [#37](https://github.com/ziyilam3999/monday-bot/issues/37) consider
  a per-run summary counter instead of per-chunk duplicate-id warn
  at larger scale

## [0.3.3](https://github.com/ziyilam3999/monday-bot/compare/v0.3.2...v0.3.3) (2026-04-20)

US-02 parser polish — fold three non-blocking enhancements from the PR #8
ship-review into a small chore PR. Stateless reviewer iter 1 caught a real
regression (setext underline firing on YAML front matter); iter 2 fix landed
in the same PR before merge.

### Miscellaneous

- **ingestion**: strip UTF-8 BOM (U+FEFF) from TXT and MD inputs before
  parsing so the marker character cannot leak into chunk text
  ([#33](https://github.com/ziyilam3999/monday-bot/pull/33), closes
  [#9](https://github.com/ziyilam3999/monday-bot/issues/9))
- **ingestion (md)**: support setext-style headings — `=== ` for H1 and
  `---` for H2. Detector peeks at the next line and, critically, requires
  the PREVIOUS line to be blank (or start-of-file) so YAML front-matter
  terminators, list-item trailers, and paragraph continuations are not
  misread as headings (closes
  [#11](https://github.com/ziyilam3999/monday-bot/issues/11))
- **tests**: tighten `UnsupportedFileTypeError` specs to assert
  `err.name === "UnsupportedFileTypeError"` in addition to `instanceof`,
  guarding against silent error-class drift (closes
  [#16](https://github.com/ziyilam3999/monday-bot/issues/16))
- **tests**: 5 new jest specs — BOM strip on TXT, BOM strip on MD,
  setext happy path, YAML-front-matter regression guard, list-trailer
  regression guard (30/30 pass)

### Bug Fixes

- **ingestion (md)**: setext detector no longer promotes the last YAML
  field value to a chunk heading when the closing `---` of a YAML front
  matter block follows it. The fix requires the line before the candidate
  heading to be blank, which also blocks analogous list-item trailer and
  paragraph-continuation false positives. Caught by the stateless
  reviewer iter 1 on PR #33.

## [0.3.2](https://github.com/ziyilam3999/monday-bot/compare/v0.3.1...v0.3.2) (2026-04-20)

US-01 scaffold hygiene — fold three non-blocking enhancements from the PR #1
ship-review into a small chore PR.

### Miscellaneous

- **env**: `validateEnv()` now returns trimmed token values
  (`env.SLACK_BOT_TOKEN!.trim()` / `env.SLACK_APP_TOKEN!.trim()`) so stray
  whitespace cannot leak into Slack client initialization
  ([#32](https://github.com/ziyilam3999/monday-bot/pull/32), closes
  [#2](https://github.com/ziyilam3999/monday-bot/issues/2))
- **env**: collapse the two-part filter `!env[key] || env[key]?.trim() === ""`
  into the single expression `!env[key]?.trim()` — same semantics, handles
  undefined/null/empty/whitespace in one optional-chain (closes
  [#3](https://github.com/ziyilam3999/monday-bot/issues/3))
- **jest**: replace deprecated `preset: "ts-jest"` with
  `...createDefaultPreset()` per ts-jest 29.x guidance; transform behavior
  preserved (closes [#6](https://github.com/ziyilam3999/monday-bot/issues/6))
- **tests**: 2 new jest specs covering whitespace-only rejection and
  trim-on-return (25/25 pass)

## [0.3.1](https://github.com/ziyilam3999/monday-bot/compare/v0.3.0...v0.3.1) (2026-04-20)

US-03 polish — fold two non-blocking enhancements from the PR #21 ship-review
into a small chore PR.

### Miscellaneous

- **vectorIndex**: `VectorIndex.load()` now throws a clear error when the
  loaded `index.json` has `chunks.length !== vectors.length`, preventing
  silent NaN cosine scores on corrupt / hand-edited files
  ([#31](https://github.com/ziyilam3999/monday-bot/pull/31), closes
  [#22](https://github.com/ziyilam3999/monday-bot/issues/22))
- **tests**: add clarifying header comment to
  `tests/__stubs__/xenova-transformers.js` disclosing it as a test-only
  fake; the real ONNX model is exercised by US-03 AC inline commands
  (closes [#25](https://github.com/ziyilam3999/monday-bot/issues/25))
- **tests**: 1 new jest spec covering the length-mismatch rejection path
  (23/23 pass)

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
