# Monday — Team Slack Knowledge Assistant

A Slack bot that answers team questions from internal documents (shared folders, Confluence) with cited, fact-based summaries. Built as a single-process Node/TypeScript service for free-tier ARM Linux.

## Status

PH-02 complete (v0.12.0, 2026-05-09). All 13 stories shipped. End-to-end usability gated on operator-side setup (Slack creds + corpus + PM2) — see Deployment section below.

| Story | Title | Status |
|-------|-------|--------|
| US-01 | TS scaffolding + secrets validation + build | done |
| US-02 | Document ingestion (TXT/MD/PDF/DOCX → chunks) | done |
| US-03 | Embeddings + vector index + persistence | done |
| US-04 | LLM answer generation (cited, facts-only) | done |
| US-05 | Knowledge service (platform-agnostic facade) | done |
| US-06 | File watcher (auto-index ≤5s) | done |
| US-07 | Confluence sync (REST + cron) | done |
| US-08 | Slack core (Socket Mode, @mention, /ask) | done |
| US-09 | Admin commands (status/sync/reindex/help/feedback) | done |
| US-10 | Graceful errors (no stack traces in Slack) | done |
| US-11 | Config file (watched paths, schedule) | done |
| US-12 | E2E integration (full round-trip) | done |
| US-13 | Deployment packaging (PM2/systemd/Docker) | done |

See [`docs/PLAN_MONDAY_BOT.md`](docs/PLAN_MONDAY_BOT.md) for the v2.0.0 product requirements (intent-only, executor-owns-how).

## What Monday does

- A user asks a question in Slack (`@Monday ...` or `/ask ...`)
- Monday searches the indexed corpus (local docs + Confluence pages)
- Returns a concise answer with **inline citations** `[1]` and a visible source list
- If the docs don't cover the question, Monday says so explicitly — never fabricates

Quality bar: facts-only, every claim traceable to a cited chunk, ~15s end-to-end on CPU.

## Stack

- **Runtime**: Node.js 20 + TypeScript 5
- **Test**: jest + ts-jest
- **Inference**: local-first (LLM runs on the same box, not via external API) — chosen for data residency and cost
- **Deployment**: free-tier ARM Linux (Oracle Cloud A1 or equivalent), single long-running process
- **Slack**: Socket Mode (Bolt SDK) — no public ingress required

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # jest
npm start          # node dist/index.js
```

Required environment variables (template in `.env.example` — story US-11):

- `SLACK_BOT_TOKEN` — Slack bot token (`xoxb-…`)
- `SLACK_APP_TOKEN` — Slack app-level token for Socket Mode (`xapp-…`)

Starting without these exits with a friendly error. No stack traces in user-facing surfaces.

## Deployment

Monday is designed as a single long-running Node process on free-tier ARM Linux
(tested target: Oracle Cloud A1 or equivalent, 1 vCPU / 1 GB RAM class).
There is no public ingress — Slack Socket Mode keeps the process behind NAT.

### Required environment variables

Set these in the shell, a `.env` file, or your process manager's env block:

- `SLACK_BOT_TOKEN` — Slack bot token (`xoxb-…`)
- `SLACK_APP_TOKEN` — Slack app-level token for Socket Mode (`xapp-…`)

Optional (depending on which stories are enabled in your build):

- `ANTHROPIC_API_KEY` — only if the Anthropic LLM path is wired in
- `MONDAY_DEBUG=1` — enables stack traces on startup failure

A template lives in [`.env.example`](./.env.example). Application config (watched
paths, Confluence schedule, ingestion knobs) lives in [`config.yaml`](./config.yaml)
— see story US-11 for the loader and schema.

Starting without `SLACK_BOT_TOKEN` or `SLACK_APP_TOKEN` exits non-zero with a
friendly message that names the missing variables.

### Build

```bash
npm install
npm run build      # tsc → dist/
```

### Run — bare metal

```bash
npm start          # node dist/index.js
```

Useful for local development and smoke tests. Not recommended for production
because there is no automatic restart on crash.

### Run — PM2 (recommended)

[PM2](https://pm2.keymetrics.io/) supervises the Node process, restarts on
crash, and persists across reboots. The repo ships
[`ecosystem.config.js`](./ecosystem.config.js) which pins:

- single fork-mode instance (Monday holds in-memory indexes — do not cluster)
- `max_memory_restart: 500M` (leaves headroom for the embedding model on 1 GB hosts)
- exponential backoff restart with `min_uptime: 10s` and `max_restarts: 10`

```bash
npm install -g pm2          # one-time, global
npm run build
pm2 start ecosystem.config.js
pm2 save && pm2 startup     # persist across reboots
pm2 logs monday             # tail logs
pm2 restart monday          # manual restart
```

### ARM Linux compatibility

All runtime dependencies are pure-JS or ship ARM-compatible prebuilds:

- `@slack/bolt`, `@anthropic-ai/sdk`, `js-yaml`, `mammoth` — pure JS
- `pdfjs-dist` — pure JS (legacy build, no native canvas required)
- `@xenova/transformers` — ships ARM64 ONNX runtime; tested on Oracle Cloud A1

No native rebuild step is required on ARM64 Linux beyond `npm install`.

## Out of scope (v1)

Web UI, CLI/terminal query, desktop app, WhatsApp/Teams/Telegram integration, multi-tenant SaaS, advanced reasoning (chain-of-thought, multi-hop synthesis). See PRD §6.

The retrieval core stays platform-agnostic so a future non-Slack adapter is a thin shim, not a rewrite.

## Repo layout (so far)

```
src/
  config/env.ts      # env validation + MissingEnvVarError
  index.ts           # entrypoint
tests/
  env.test.ts        # jest specs for the validator
docs/
  PLAN_MONDAY_BOT.md # PRD v2.0.0 (intent-only)
.ai-workspace/
  plans/             # per-story implementation plans
.github/workflows/
  ci.yml             # build + test on ubuntu + windows
```

## License

Internal project. No license declared yet.
