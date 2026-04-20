# Changelog

All notable changes to monday-bot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
