# Monday — Team Slack Knowledge Assistant

A Slack bot that answers team questions from internal documents (shared folders, Confluence) with cited, fact-based summaries. Built as a single-process Node/TypeScript service for free-tier ARM Linux.

## Status

Active development. Bootstrap pipeline in progress.

| Story | Title | Status |
|-------|-------|--------|
| US-01 | TS scaffolding + secrets validation + build | done |
| US-02 | Document ingestion (TXT/MD/PDF/DOCX → chunks) | ready |
| US-03 | Embeddings + vector index + persistence | pending |
| US-04 | LLM answer generation (cited, facts-only) | pending |
| US-05 | Knowledge service (platform-agnostic facade) | pending |
| US-06 | File watcher (auto-index ≤5s) | pending |
| US-07 | Confluence sync (REST + cron) | pending |
| US-08 | Slack core (Socket Mode, @mention, /ask) | pending |
| US-09 | Admin commands (status/sync/reindex/help/feedback) | pending |
| US-10 | Graceful errors (no stack traces in Slack) | pending |
| US-11 | Config file (watched paths, schedule) | ready |
| US-12 | E2E integration (full round-trip) | pending |
| US-13 | Deployment packaging (PM2/systemd/Docker) | pending |

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
