# PRD: Monday — Team Slack Knowledge Assistant

**Version**: 2.0.0
**Date**: 2026-04-19
**Status**: Intent-focused rewrite — HOW is left to the executor.

### Changelog

| Version | Date | Changes |
|---------|------|---------|
| 2.0.0 | 2026-04-19 | **Intent-only rewrite.** Removed all HOW (model names, library choices, project structure, code samples, token math, chunk-size numbers, dep lists, YAML schemas). Kept WHAT users experience and WHY each requirement exists. Previous HOW-heavy draft retained at `PLAN_MONDAY_BOT.v1.1-how-heavy.bak.md` as reference material — not authoritative. |
| 1.0.0 – 1.1.0 | 2026-03-09 – 2026-03-10 | Original plan with prescriptive implementation details (archived). |

---

## ELI5

Right now, one person has an AI assistant on their laptop that answers questions about company documents. We want to give the whole team the same assistant — but as a bot that lives in their Slack. They type a question, the bot reads the company's shared docs and Confluence pages, and answers in 200 words with citations. The bot never guesses; if the docs don't cover it, it says so. It runs on a free Malaysia cloud server the team can share.

This document describes **what** the bot should do and **why** — not **how** to build it. The executor picks the tech.

---

## 1. Problem & Vision

### Current state
A single user has a **local Python desktop application** (AI File Search) that embeds and queries company documents on their laptop. It has a Flask web UI, a PyWebView desktop shell, and a CLI. It only serves one person.

### Target state
A **team-shared Slack bot named "Monday"** that any team member can query from their existing Slack workspace. Monday reads the same class of documents (shared folders, Confluence), produces the same kind of cited answers, and serves 2–15 people at once.

### Why this change is worth doing
1. **Access**: The team does their work in Slack. A knowledge tool belongs where the work happens — not behind a single-user desktop app.
2. **Shared infra**: One deployed bot serves the whole team. No per-user installation, no syncing indexes between laptops.
3. **Clean break over migration**: The existing codebase carries three user interfaces (Flask, PyWebView, CLI) that are all being dropped. A rewrite removes the dead UI layers, the dependency stack that only served them, and a decade of Python-specific patterns — cheaper than incrementally gutting the old repo.
4. **Deployment simplicity**: A single-process bot deployed once is operationally much simpler than a Python ML desktop app distributed to N laptops.

---

## 2. Users & Context

### Primary users
- **A small team (2–15 people)** using Slack daily.
- Based in **Malaysia** (deployment region constraint drives hosting choice).
- Typical question categories: "how do I do X", "what's our policy on Y", "where is the document about Z".

### Source content
- **Shared document folders** (local to the deployment, mounted or synced) containing internal knowledge: IT guides, HR policies, onboarding docs, runbooks, etc. File formats include plain text, Markdown, PDF, and Word documents.
- **Confluence spaces** (one or more) — an existing wiki the team already uses.
- Corpus size: **hundreds to low thousands of documents** (not millions). This is "team wiki" scale, not "enterprise search" scale.

### Non-users / Non-goals
- External customers. Monday is an internal tool.
- Non-Slack users. Field workers or employees without Slack are explicitly out of scope for v1 (see §6).

---

## 3. What Monday Does

These are the **user-observable behaviors**. The executor decides implementation; the behaviors are non-negotiable.

### 3.1 Ask-and-answer (the core loop)
1. A user types a question in Slack — either as a slash command (`/ask ...` or similar) or by mentioning the bot (`@Monday ...`).
2. Monday acknowledges immediately so Slack doesn't time out.
3. Monday replies in the same channel or thread with:
   - A **concise, fact-based answer** (see §4 Quality Requirements).
   - **Inline citations** (`[1]`, `[2]`, …) referencing the specific source documents the answer came from.
   - A **visible source list** showing which file or Confluence page each citation maps to.
4. The user can optionally see the answer build up progressively (streaming-style updates) so a 10–15 second wait feels responsive rather than dead.

### 3.2 Keeping content fresh
- **Dropping a new document** into a watched folder → it becomes searchable within a few seconds without restarting the bot.
- **Editing or deleting a document** → the change is reflected in search results; deleted content stops appearing in citations.
- **Confluence pages** are synced on a user-triggered command and/or a periodic schedule (e.g. nightly). Updated pages replace stale versions.
- A **full periodic reindex** (e.g. nightly) is acceptable as a belt-and-braces correctness measure.

### 3.3 Admin from within Slack
Team admins should be able to see status and trigger maintenance **without SSH'ing into the server**. The following actions are exposed as Slack slash commands (exact names at the executor's discretion):
- **Show status**: how many documents are indexed, is the file watcher alive, is the bot connected to Slack, uptime.
- **Trigger Confluence sync**: pull the latest Confluence content on demand.
- **Trigger full reindex**: rebuild the index from scratch.
- **Help**: list available commands.
- **Submit feedback**: a one-line "this answer was wrong / this is great" capture, logged somewhere the owner can review.

Non-admin actions (like `/ask`) are available to everyone in the workspace.

### 3.4 Graceful failure
- If no relevant documents are found, Monday says so explicitly — it does not fabricate an answer.
- If the LLM or index service is down, Monday posts a human-readable error to the user, not a stack trace.

---

## 4. Quality Requirements

### 4.1 Facts-only, not reasoning
Monday **reports what the documents say**. It does **not** reason, infer, guess, or connect dots the documents don't connect themselves.

**Why this matters**: This is an internal knowledge tool used for operational decisions (policy lookups, procedure steps, contact info). A wrong-but-plausible answer is worse than "I don't know" because it becomes the source of downstream mistakes. Teams need to be able to trust Monday's output without double-checking every claim.

Practical observable consequences:
- Every claim in the answer should be traceable to a cited source.
- If the documents partially cover the question, Monday says what they cover and what they don't — it doesn't fill the gap with conjecture.
- If the documents don't cover the question at all, Monday says "I couldn't find anything relevant" and stops.

### 4.2 Answer shape
- **Length**: concise summaries — short enough to read at a glance, long enough to be genuinely useful without the user having to open the source document. Roughly one Slack-message-sized response.
- **Structure**: short paragraphs or bullet points where appropriate. Not a wall of text.
- **Citations are real**: a `[1]` in the answer must correspond to a chunk that was actually retrieved and used. No phantom references.
- **Citations are visible**: the user can see which file or Confluence page each number maps to, without clicking away.

### 4.3 Retrieval quality
- When a user asks about **a specific topic or section** (e.g. "VPN setup", "refund policy"), Monday should preferentially return chunks from the relevant section of the relevant document — not chunks that happen to share vocabulary with unrelated sections.
- The retrieval pipeline must not have **structural blind spots**: if a chunk is stored in the index, it must be fully reachable by queries. (This is a concrete constraint — the executor should ensure embeddings cover the full chunk content, not silently truncate the tail.)
- When the corpus has **well-structured documents with headings** (Markdown, DOCX, Confluence), Monday should exploit that structure to improve retrieval, not ignore it.

### 4.4 Response time
- **Acceptable on CPU**: up to ~15 seconds end-to-end for a typical question. This is the baseline because v1 must run on free-tier CPU hardware.
- **Target on GPU (if later provisioned)**: under 5 seconds end-to-end.
- **Perceived latency** matters more than wall-clock latency: streaming partial answers or posting "Searching…" placeholders makes a 12-second wait feel reasonable.

### 4.5 Correctness across source formats
The following formats must be handled **with similar answer quality**:
- Plain text (`.txt`)
- Markdown (`.md`)
- PDF (`.pdf`)
- Word documents (`.docx`)
- Confluence pages (via the Confluence REST API)

If some formats produce noticeably worse answers than others (e.g. PDF tables dropped entirely), that is a quality defect to fix, not a limitation to ship with.

---

## 5. Operational Constraints

These are the fixed inputs the executor must design around. They are the "why" behind most of the HOW decisions the executor will make.

### 5.1 Deployment target
- **Must run on a free-tier Malaysia cloud instance** (e.g. Oracle Cloud Free Tier ARM Ampere A1 — 4 OCPUs, 24 GB RAM — or an equivalent free-tier offering in the region).
- **CPU-only acceptable for v1.** GPU is a later optimization, not a requirement.
- Whatever the executor chooses must actually fit in the free-tier resource envelope (RAM, disk, ARM architecture) without paid infrastructure.

### 5.2 Single-process service
- The deployed unit is **one long-running process**, not a constellation of services. No separate database server, no separate web UI process, no separate worker queue.
- Minimal binary dependencies — the service must build and run on ARM Linux without fragile native-extension pain.

### 5.3 Slack is the only v1 UI
- No web dashboard.
- No CLI or terminal query interface.
- No desktop app.
- The only way a user (or admin) interacts with Monday is through Slack.

**Implication**: the Slack integration layer should be **thin** and isolated from the core knowledge-retrieval logic, so that a future WhatsApp / Teams / Web integration (see §6) can be added without rewriting the core.

### 5.4 Team-operable
- **Deployment must be tractable for a small team without a dedicated DevOps person.** Any reasonable delivery format is fine (container image, single binary, plain Node process + process manager) as long as a team lead can deploy, monitor, and restart it without specialist knowledge.
- **Secrets** (Slack tokens, Confluence API tokens) live in environment variables or an equivalent standard mechanism — not hardcoded, not in git.
- **Non-secret config** (watched paths, reindex schedule, etc.) lives in a human-readable config file the team lead can edit.

### 5.5 Stated implementation preferences (user decisions already made)
These are **user preferences** carried forward from the previous draft, not fresh constraints. The executor may deviate with justification, but absent strong reasons, default to these:
- **Node.js / TypeScript ecosystem** for the whole service — driven by deployment simplicity (fewer native-binary issues than Python ML stacks on ARM) and the fact that Slack's official SDK is TypeScript-first.
- **Local-first inference** (the LLM runs on the same box, not via an external API) — driven by data-residency and cost considerations for a small team with internal documents.

---

## 6. Out of Scope (v1)

The following are **intentionally excluded** from v1. Do not implement them; do not design infrastructure that assumes them.

- **Web UI / browser-based search** — Slack is the interface.
- **CLI / terminal query interface** — dropped with the Python rewrite.
- **Desktop app** (PyWebView, Electron, etc.) — dropped with the Python rewrite.
- **WhatsApp, Teams, Telegram, or any non-Slack messaging integration.** *However*, the core knowledge/retrieval logic must remain **platform-agnostic** — no Slack-specific types leaking into the retrieval layer — so a future integration is a thin adapter, not a rewrite.
- **Multi-tenant SaaS** / cross-team workspaces / per-user knowledge scopes.
- **Fine-tuning** or custom-training the embedding or generation models.
- **External (paying) customer access.**
- **Advanced reasoning modes** (chain-of-thought, multi-hop synthesis). The v1 bot is facts-only; reasoning modes are a future decision gated on evaluating stronger models (see §7).

---

## 7. Phased Rollout (Intent Only)

The executor chooses the granularity, branch strategy, and order of implementation. What matters is that each phase delivers an observable outcome.

### Phase 1 — Dev / solo validation
**Outcome**: a single developer can run Monday on their laptop, point it at a folder of test documents, ask questions in a personal Slack test workspace, and get cited answers.

### Phase 2 — Team deployment on free-tier cloud
**Outcome**: Monday is running on the Malaysia free-tier instance. The whole team can use it in their Slack workspace. It indexes shared documents and Confluence. Response time is within the CPU target (§4.4).

### Phase 3 — Optional GPU scale
**Outcome**: only executed **if** Phase 2 response time is a real user complaint, **or** the team outgrows 15 people, **or** a stronger model is adopted. Response time meets the GPU target (§4.4).

No code should change when moving between Phase 2 and Phase 3 other than the deployment target — the application should transparently use whatever hardware it's deployed on.

---

## 8. Success Criteria (Observable, Binary)

These are the observable checks. Pass/fail should be callable from outside the diff — from a user's perspective or from a shell script — not from inspecting internal structure.

1. **Query round-trip**: a user sends a question in Slack and receives an answer that contains at least one inline citation and a visible source list, within the §4.4 CPU time bound.
2. **Citation integrity**: every inline citation in an answer maps to a real document in the index. A reviewer can open the cited document and find the claimed content.
3. **Unknown-answer behavior**: for a question whose answer is not in the indexed corpus, Monday replies with an explicit "I couldn't find…" message rather than a fabricated answer.
4. **Document freshness**: adding a new document to a watched folder makes it retrievable within a few seconds without a service restart.
5. **Confluence sync**: running the sync command pulls fresh Confluence content; pages updated since the last sync replace their older versions in the index.
6. **Status visibility**: the status slash command returns document count, watcher health, and uptime — without SSH.
7. **Free-tier fit**: the deployed service runs on the chosen free-tier Malaysia instance for at least 24 hours without exhausting RAM, disk, or CPU quota.
8. **Format coverage**: the same question asked against the same content stored in each of the supported formats (TXT, MD, PDF, DOCX, Confluence) returns answers of comparable quality. Large quality drops on any one format are defects.
9. **Graceful failure**: killing a dependency (e.g. the LLM process) produces a user-visible, human-readable error in Slack — not silent hangs or stack traces.
10. **Secrets hygiene**: a fresh clone of the repo contains zero secrets; starting the bot without the required environment variables fails with a clear message.

---

## 9. Open Decisions Explicitly Left to the Executor

The executor (whether a human engineer, `forge_plan`, or a downstream agent) owns these decisions. The PRD does **not** prescribe them:

- **Language and runtime specifics** (version of Node, bundler, package manager).
- **LLM**: which model, which size, which quantization, which inference library. Constraint: meets §4 quality + §4.4 latency on §5.1 hardware.
- **Embedding model**: which one. Constraint: meets §4.3 retrieval quality without blind spots, fits in §5.1 resources.
- **Vector index**: which library / format / storage layout.
- **Metadata store**: relational DB, key-value store, flat files — executor's call, as long as it survives restarts and handles the §3.2 freshness guarantees.
- **Document extraction libraries**: which PDF / DOCX / etc. parser.
- **Chunking strategy**: chunk size, overlap, top-K, section-awareness approach — whatever best satisfies §4.3 without structural blind spots.
- **Prompt engineering**: the exact prompt wording, rule ordering, and system-message framing — as long as §4.1 (facts-only) and §4.2 (answer shape) hold observably.
- **Slack transport**: Socket Mode vs HTTP Events API — whichever is operationally simpler for §5.4.
- **Deployment format**: Docker image, native systemd unit, pm2 config, etc.
- **Project structure**: folder layout, module boundaries, naming.
- **Test framework**: whatever the executor is fluent in.

---

## 10. Reference Material

A previous prescriptive draft (v1.1.0) of this plan contains a *proposed* technical architecture — including specific model choices, library selections, project folder structure, chunk-size analysis, and prompt wording. It lives at `docs/PLAN_MONDAY_BOT.v1.1-how-heavy.bak.md` and is **not authoritative**. It may be read as a source of candidate implementation options and prior reasoning, but the executor is free to deviate wherever a different choice better satisfies this PRD.

---

## Summary

Monday is a Slack bot that answers company questions from internal documents with cited, fact-based summaries. It runs as a single process on free-tier Malaysia cloud, serves a small team, and never reasons beyond what the documents actually say. Everything else — model, libraries, folder structure, prompt wording — is the executor's call.
