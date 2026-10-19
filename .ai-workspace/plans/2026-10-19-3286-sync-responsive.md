# 3286 — monday-bot stays responsive while knowledge syncs run

size: L
data-class: public
Ticket: #3286
Branch: 3286-sync-responsive (worktree from origin/master f80f204)
Status: PLAN — first draft, awaiting plan-review round 1
SUITES: none

cairn: T1 stone 2026-10-18 (`t1-run-scratch/2026-10-18/…jsonl:362`): "Monday bot goes deaf for minutes after every restart: initial Jira/Confluence sy[nc]…" — the operator-filed symptom this plan is bounded by (receipt `tmp/cairn-3286.log:1`). No T1/T2 stone contradicts the approach; nearest neighbors are forge-era session notes only.
cairn-wiki: wiki tier off

## ELI5

When the bot starts (or its 6-hourly refresh fires), it re-reads its whole document library — ~895 Jira issues + ~306 Confluence pages — and "understands" each passage with a local AI model that runs on the very same single thread that listens to Slack and Telegram. For ~4 minutes it is thinking so hard it cannot hear anyone: Slack socket pings time out, DNS calls fail, questions go unanswered until indexing ends. Two fixes. First, the bot takes small breaths between passages while indexing, so it never stops listening for more than a second. Second, it writes what it understood down on disk, so after a restart it remembers yesterday's work instead of re-understanding everything — only genuinely changed documents get re-embedded. Bonus truth-telling: today, a question asked during the first index gets "I couldn't find any relevant information" — a lie. It will instead say it is still warming up.

## Intent (what and why)

**What.**

1. **Responsive syncs (Part A).** While ANY sync runs — the initial background sync at boot, the scheduled 6-hourly re-sync, and the on-demand `/reindex` + `/sync-confluence` paths — the event loop keeps turning at a bounded cadence, so both channels (Slack Socket Mode + Telegram long polling, same process, same loop) keep answering. Measurable bound: a timer/ping-style handler is never delayed more than **1 s** during a sync of **N = 60 fixture documents (≥ 300 passages)** through the production sync path.
2. **No re-embedding of unchanged documents (Part B).** The index survives restarts on disk; a restart warms the index from that persisted state and the following sync re-embeds only what actually changed.
3. **Truthful warm-up answer (Part A).** A question that arrives while the FIRST index is still being built gets a "still warming up" answer instead of the false "couldn't find any relevant information" copy.
4. **Answer quality unchanged.** Same retrieval results on a fixed fixture corpus before vs after (cache-warm vs freshly embedded must be identical).

**Why.** Operator-filed defect (T1 stone above): after every restart and every scheduled re-sync the bot goes silent ~4 minutes — Slack logs fill with `pong wasn't received` and `getaddrinfo ENOTFOUND slack.com` while the local embedding model monopolizes the main thread. Cost focus: every restart also pays the full re-embedding CPU cost for ~1,200 documents that did not change.

## Evidence verified (load-bearing premises at HEAD f80f204)

| Premise | Verified |
|---|---|
| Channels report "listening" BEFORE any sync completes | `src/index.ts` — `runMonday` starts `startKnowledgeSources` (background), then `adapter.start()` + "Monday is listening", then Telegram; `sources.ready` is never awaited before answering |
| Initial + scheduled + on-demand syncs all re-embed everything | `src/knowledge/startup.ts` (initial promises, 6 h `DEFAULT_SYNC_INTERVAL_MS` timers, `reindexAll`/`syncConfluence`); `src/knowledge/service.ts` `indexConfluencePage` does `removeBySource(source)` then re-adds EVERY passage |
| Embedding runs on the main thread, in-process, no persistence | `src/embeddings/embed.ts` — `@xenova/transformers` pipeline (`Xenova/all-MiniLM-L6-v2`) built once per process; `VectorIndex.add`/`search` `await embed(text)` per chunk/query on the calling thread |
| The index is in-memory only; save/load exist but are DEAD CODE in production | `src/index/vectorIndex.ts` has `save(dir)`/`load(dir)` (model-stamped `index.json`, corrupt-length guard); `grep` shows the only production constructor is `service.ts:148` — nothing calls save/load |
| Save/load round-trip + guards are already tested | `tests/vectorIndex.test.ts` — fidelity round-trip, model-mismatch rejection, corrupt-length rejection, ranking-order preservation |
| Both channels share one query funnel | `src/telegram/adapter.ts:21` imports `handleQuery` from `src/slack/queryHandler.ts`; Slack `app_mention` + `/ask` use the same — one fix covers both |
| Empty index currently answers "couldn't find any relevant information" | `src/knowledge/service.ts` `NO_DOCUMENTS_ANSWER` — false negative during first boot |
| Fixture-driven sync tests are the established pattern | `tests/knowledge-sources.startup.test.ts` — stub Confluence/Jira fetchers + fake scheduler, zero network |
| Real local-model tests are the established pattern | `tests/embed.test.ts` (120 s timeout) — the suite already exercises the local MiniLM model; no Jira/Confluence/Slack/Telegram/Anthropic call is involved |

Doc volumes (~895 / ~306) are operator-observed numbers from the ticket, not re-derived here; smokes scale them down to fixtures.

## Design decisions (what, not how)

1. **Responsiveness is a measured contract, not a mechanism mandate.** During any sync, pending timers and I/O must be served within the AC-2 bound (≤ 1 s observed delay). The executor may achieve it with cooperative yielding between passage embeddings (smallest blast radius; the per-passage work unit is already the natural boundary) — a worker-thread embedder is explicitly DEFERRED (see follow-ups) because cooperative scheduling meets the bound with far less risk. Total sync wall-time may grow slightly; responsiveness is the goal.
2. **The persisted index is the cache; "unchanged" = same source id + same content hash + same embedding model.** The store lives in one data directory (env-overridable, default `.monday-cache/` at the repo root, gitignored) holding the model-stamped index snapshot (the existing save/load shape) plus a per-source content-hash manifest. On sync: source present in the loaded index AND manifest hash matches → skip re-indexing that document entirely; otherwise replace it and re-embed its passages. Passage text (not title/metadata alone) feeds the hash so a body edit can never masquerade as unchanged.
3. **Model change invalidates everything.** Both files carry `EMBEDDING_MODEL`; any mismatch on load → discard the whole store, one WARN line, full re-embed via the normal sync path (the existing `load()` model guard already throws; production wiring catches and rebuilds).
4. **Corrupt or missing store → full re-embed, never a crash, never a silently empty index.** Any parse/shape failure (truncated JSON, length mismatch, missing dir) is caught, logged once, and treated as absent: boot proceeds, the sync repopulates, and the warming-up answer (decision 5) covers the gap. Writes are atomic (temp file + rename) so a crash mid-write cannot produce the corrupt case in the first place.
5. **YES to "still warming up" — bounded and justified.** Only while the index is EMPTY and an initial sync is IN FLIGHT does `query()` return a warming-up copy; once any documents are indexed, questions answer normally from what is there (partial beats refusal); and when NO sources are configured at all (no creds) the old "couldn't find any relevant information" copy stays, so a misconfigured bot cannot hide behind "warming up" forever. Justification: the current copy is factually wrong during first boot and has already been read as a retrieval defect; the truthful message costs one string and disappears entirely once Part B's warm start lands (post-restart the index is non-empty from disk). Both channels get it for free via the shared `handleQuery` funnel.
6. **Warm start serves last-known-good between load and first sync completion.** After a restart, queries may briefly see the persisted index (at most one restart old) while the initial sync refreshes it. Accepted tradeoff: a seconds-stale answer beats four minutes of deafness or a false "nothing found".
7. **Quality = retrieval identity; the generator is untouched.** Parity is asserted through `KnowledgeService.retrieve()` (the production ranking path — expansion, doc-prior, diversity cap all in play), not a reimplementation, with the LLM stubbed. Cache-hit vectors must equal freshly embedded vectors to numerical epsilon; ordering must be identical.
8. **Smokes are fixture-only, and harnesses refuse when their target is unset.** New smokes drive stub fetchers (existing pattern) over checked-in fixture documents; no real Jira/Confluence/Slack/Telegram/Anthropic call happens anywhere in them (the local `@xenova` model the suite already uses is the only model artifact). The new standalone smoke runner refuses with a non-zero exit and an explicit message when its fixture target env is unset — it never falls back to a live target (standing rule).
9. **Split into two independently shippable parts, A then B** (see next section). Not in scope: worker-thread/remote embedding, cursor-pagination changes, any `.env` change, any prompt/model change, restarting or redeploying the live bot (ship-tail concern).

## Size + split — this is L, not M

The dispatch called this M; honestly it is **L**: two orthogonal mechanisms (responsive scheduling + a persisted cache with invalidation/fallback semantics), production wiring across `embeddings`, `index/vectorIndex.ts`, `knowledge/service.ts`, `knowledge/startup.ts`, `index.ts`, a new smoke suite + standalone runner, and blast radius covering BOTH channels. Proposed split, one PR each, same ticket:

- **Part A — responsiveness (PR 1):** cooperative sync scheduling (AC-2), warming-up answer (AC-3), the standalone smoke runner + refuse rule (AC-4). Independently valuable: it alone ends the operator-visible deafness.
- **Part B — persisted index cache (PR 2):** warm start on boot, unchanged-doc skip, invalidation + fallback (AC-5..AC-9), parity (AC-9), no-real-services grep (AC-10). Depends on Part A only for the warming-up copy covering its fallback gap.

### Binary AC (checkable from OUTSIDE the diff; run from the worktree root; `tests/fixtures/sync-responsive/` is the new checked-in fixture corpus)

| # | Part | Check | Pass condition |
|---|---|---|---|
| AC-1 | A+B | `npm run typecheck && npm test` | both exit 0 |
| AC-2 | A | `npm test -- tests/sync-responsive.smoke.ts -t heartbeat` | exit 0; the smoke drives the PRODUCTION sync path (real `ConfluenceSync`/`JiraSync` + `KnowledgeService`, stub fetchers, fake scheduler) over ≥ 60 fixture docs (≥ 300 passages) while a monotonic-clock heartbeat samples handler wake-ups every 250 ms: max observed delay ≤ 1000 ms; AND a `query()` issued mid-sync (stub generator) resolves BEFORE the sync completes |
| AC-3 | A | `npm test -- -t warming` AND `command grep -rn "still warming up" src/` | test exit 0 with all three: empty index + in-flight initial sync → answer matches /warming up/ and does NOT contain "couldn't find any relevant information"; sync settled with docs → normal answer; no sources configured → old copy retained; grep prints ≥ 1 hit in src/ |
| AC-4 | A | `node scripts/sync-responsive-smoke.js` (target env unset) then `SMOKE_FIXTURES=tests/fixtures/sync-responsive node scripts/sync-responsive-smoke.js` | first run: exit ≥ 1 AND output names the unset target (refuses, never falls back to a live target); second run: exit 0 on the fixture-only heartbeat workload |
| AC-5 | B | `npm test -- tests/sync-responsive.smoke.ts -t "embedding cache"` | exit 0; restart simulated as save → new index/service instance → load: re-sync of the SAME fixture corpus triggers ZERO chunk-embedding calls for unchanged docs (spy on the embedding entry point), and the reloaded index answers queries |
| AC-6 | B | same suite, `-t "embedding cache"` | exactly one fixture document edited between syncs → the embedding-call delta equals THAT document's passage count and nothing else's; all other docs zero |
| AC-7 | B | same suite, `-t "model"` | persisted store stamped with a foreign model id → discarded at load, full re-embed repopulates the index, exactly ONE warn-level log line, zero thrown/unhandled errors |
| AC-8 | B | same suite, `-t "fallback"` | BOTH a truncated/garbage store AND a missing store dir → boot continues, the sync repopulates, `query()` returns an answer, no unhandled rejection, one fallback log line per case |
| AC-9 | B | `npm test -- tests/sync-responsive.smoke.ts -t parity` | for the fixed corpus + ≥ 8 fixture questions, `retrieve()` (production path, default topK 12) from the cache-warm index returns the SAME chunk ids, sources and order as a freshly embedded index, scores within 1e-6 |
| AC-10 | A+B | `command grep -rnE "globalThis\.fetch|new Anthropic|@slack/bolt|@anthropic-ai/sdk" tests/sync-responsive.smoke.ts scripts/sync-responsive-smoke.js` | exit 1 (zero matches — fixture-only smokes; injected stubs that throw-if-called are asserted inside the suite) |

## Risks

| Risk | Mitigation |
|---|---|
| Yielding lengthens total sync wall-clock (same CPU, spread out) | Accepted — the defect is deafness, not sync duration; Part B removes most of the re-embed work anyway |
| Fixture bound met but the real ~1,200-doc corpus still shows > 1 s gaps (e.g. one monster passage) | Passage size is already bounded by the chunker (`maxChars` ~900); ship-tail operator check watches the launchd log; escalate to the deferred worker-thread follow-up if observed |
| Cache-warm answers are one restart stale between load and first sync | Decision 6 — accepted, bounded, better than the alternatives; the warming-up copy still covers the truly-empty case |
| Two processes sharing one data dir corrupt each other | Out of scope — launchd runs a single instance; the atomic-write + corrupt-fallback path contains the damage regardless |
| First CI run downloads the local MiniLM model | Precedent: `tests/embed.test.ts` already runs the real local model (120 s timeout); no new external service dependency |
| `removeBySource` + re-add churn defeats the skip (everything re-embedded anyway) | AC-5/AC-6 assert the spy count — the skip must actually prevent the embed calls, not just the wall-clock |

## Deferred-follow-ups:

- Worker-thread (or subprocess) embedder to take embedding fully off the main thread — DEFERRED; file a task if the ship-tail log shows > 1 s gaps on the real corpus after Part A.
- Exposing warming/sync state on `/status-monday` — DEFERRED; none.
- Compacting the store when documents are deleted upstream — DEFERRED until the store's size is a real problem; the empty-body-as-delete path already drops chunks from the live index.

## Planner runs

DISPATCH-NONCE:OR-NONCE-14f1a69fef4e6ef6
