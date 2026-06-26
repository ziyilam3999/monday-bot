# Monday — Team Slack Knowledge Assistant

A Slack bot that answers team questions from internal documents (shared folders, Confluence) with cited, fact-based summaries. Built as a single-process Node/TypeScript service.

## Status

13/13 stories shipped — see [CHANGELOG](CHANGELOG.md) / [docs/PLAN_MONDAY_BOT.md](docs/PLAN_MONDAY_BOT.md) for story-level history. For production setup see the [Deployment section below](#deployment).

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
- **Deployment**: single long-running Node process, supervised locally (macOS launchd)
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

Monday is a single long-running Node process. There is no public ingress —
Slack Socket Mode keeps the process behind NAT.

### Required environment variables

Set these in the shell, a `.env` file, or your process manager's env block:

- `SLACK_BOT_TOKEN` — Slack bot token (`xoxb-…`)
- `SLACK_APP_TOKEN` — Slack app-level token for Socket Mode (`xapp-…`)

Optional (depending on which stories are enabled in your build):

- `ANTHROPIC_API_KEY` — only if the Anthropic LLM path is wired in
- `MONDAY_DEBUG=1` — enables stack traces on startup failure

A template lives in [`.env.example`](./.env.example). Application config
(Confluence schedule, ingestion knobs) lives in [`config.yaml`](./config.yaml)
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

### Run — launchd (recommended, macOS)

For an always-on, always-logged-in Mac, you can run Monday under macOS's native
service supervisor **launchd** — no extra global install. launchd starts Monday
at login, keeps it alive, and restarts it on crash.

The repo is public, so it ships a placeholder **template**
([`deploy/launchd/com.monday-bot.plist.template`](./deploy/launchd/com.monday-bot.plist.template))
plus an installer that resolves the real node path / repo dir / log dir on your
machine and writes the filled plist to `~/Library/LaunchAgents/`.

**Prerequisites:** `npm run build` (produces `dist/`) and a populated `.env` in
the repo root (Monday self-loads `.env` at startup — v0.12.6+ — so no secrets go
into the plist).

```bash
npm run build
bash scripts/install-launchd.sh          # writes the plist, then prompts to activate
```

The installer prints the exact `launchctl` activation commands and (with your
confirmation) runs them:

```text
launchctl bootout    gui/$(id -u)/com.monday-bot 2>/dev/null || true
launchctl bootstrap  gui/$(id -u) ~/Library/LaunchAgents/com.monday-bot.plist
launchctl enable     gui/$(id -u)/com.monday-bot
launchctl kickstart -k gui/$(id -u)/com.monday-bot
```

It fails loudly if `node`, `dist/index.js`, or `.env` is missing, and it is
idempotent — re-running tears down the old instance (`bootout`) before
re-bootstrapping. Use `bash scripts/install-launchd.sh --print-only` to preview
the rendered plist without writing anything.

**Status & logs:**

```bash
bash scripts/install-launchd.sh status                                  # launchctl print
tail -f ~/Library/Logs/monday-bot.out.log ~/Library/Logs/monday-bot.err.log
```

> launchd does not rotate these log files. If they grow large, truncate them
> (e.g. `: > ~/Library/Logs/monday-bot.out.log`) — the running agent keeps appending.

**Update** (after pulling new code):

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.monday-bot   # restart with the new dist/
```

**Uninstall:**

```bash
bash scripts/install-launchd.sh uninstall            # bootout + remove the plist
```

> **Caveat:** a **LaunchAgent** runs only while the user is logged in — which is
> exactly right for an always-on, logged-in Mac. For pre-login / headless
> operation you would instead need a **LaunchDaemon** in `/Library/LaunchDaemons/`
> (installed as root, no access to the user session). That is out of scope here.

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
