# 3286 — monday-bot stays responsive while knowledge syncs run

size: L
data-class: public
Ticket: #3286
Branch: 3286-sync-responsive (worktree; round 2 written at ce7ca55)
Status: PLAN — round 2, revised after plan-review r1 NEEDS-WORK (round-1 premise "embeddings block the loop" refuted by execution → diagnose-first)
SUITES: none

cairn: "monday" -> T1 stone 2026-10-18 line 362: "Monday bot goes deaf for minutes after every restart: initial Jira/Confluence sy[nc]…" — the operator-filed symptom this plan is bounded by (receipt `tmp/cairn-3286.log:1`). No T1/T2 stone contradicts the approach; nearest neighbors are forge-era session notes only.
cairn-wiki: wiki tier off

## ELI5

Every restart and every 6-hourly refresh, the bot re-reads its whole document library — ~895 Jira issues + ~306 Confluence pages — and for about four minutes it goes deaf: Slack pings time out, questions go unanswered. The obvious suspect (the local "understanding" model hogging the bot's one thread) was measured during plan review and is innocent — it works in small off-thread bites. So this plan measures first: a probe watches a full re-sync and receipts WHICH work actually deafens the bot, and a written rule maps that receipt to the matching fix. If nothing reproduces the deafness on this machine, only the measuring instrument ships into production, and the fix is decided from real numbers instead of a guess. Two sure things ship regardless: the bot writes what it understood to disk, so restarts re-read only what changed (and forget documents deleted upstream) instead of re-understanding all ~1,200; and a question asked during the very first index gets a truthful "still warming up" instead of the false "couldn't find anything".

## Intent (what and why)

**What.**

1. **Diagnose first (Part A, stage 1).** At HEAD, a full fixture-scale re-sync through the production sync path is probed with an event-loop-delay histogram (`monitorEventLoopDelay`) plus per-channel handler-latency sampling (stand-ins for the Slack and Telegram handlers on the same loop). The probe receipts passage count, max + p99 loop delay, max handler latency per channel, and names the dominant stall source. The responsiveness MECHANISM is chosen only from that receipt, via the decision rule below.
2. **Responsiveness as a measured contract on the REAL path (Part A, stage 2).** During any sync — initial background sync at boot, scheduled 6-hourly re-sync, on-demand `/reindex` + `/sync-confluence` — handler wake-ups and event-loop delay stay ≤ 1 s at fixture scale (≥ 60 docs / ≥ 300 passages), and a question asked mid-sync is answered before the sync completes. Measured by a plain-node standalone runner using the real embedding backend — never by jest (decision 2).
3. **No re-embedding of unchanged documents (Part B).** The index survives restarts on disk; a restart warms from the persisted state; a document is skipped only when source id + content hash (passage text AND title/heading) + embedding model all match. Documents deleted upstream leave the index and the store; store size is bounded by the live corpus.
4. **Store I/O must not re-create the stall (Part B).** Save and load of a ≥ 5,000-passage / ≥ 20 MB store keep event-loop delay ≤ 250 ms per operation.
5. **Truthful warm-up answer (Part A).** Empty index + initial sync in flight → "still warming up"; initial sync failed → a distinct sync-failed copy; no sources configured at all → the old "couldn't find any relevant information" copy stays.
6. **Answer quality unchanged.** Retrieval identity on a fixed fixture corpus, cache-warm vs freshly embedded (same ids, sources, order; scores within 1e-6).

**Why.** Operator-filed defect (T1 stone above): ~4 minutes of deafness after every restart and re-sync (`pong wasn't received`, `getaddrinfo ENOTFOUND slack.com`). Plan-review r1 refuted the round-1 causal premise by execution (13–15 ms per embed, off-thread; timer wake delay ≤ 0.1 ms under a 60-embed loop) — so diagnosis is now the load-bearing step and no mechanism ships without a receipt. Cost focus: every restart also pays the full re-embedding CPU cost for ~1,200 documents that did not change.

## Decision rule (measurement → fix; the receipt picks the row)

The probe classifies the dominant stall into exactly one row; Part A stage 2 implements that row's fix:

| Row | Receipt says | Part A ships |
|---|---|---|
| R0 | No stall reproduced: max loop delay ≤ 1 s AND max handler latency ≤ 1 s at fixture scale on the probe machine | Mechanism leg CANCELLED. Ship the probe's measurement core as production instrumentation: every sync logs a loop-delay histogram summary + per-channel handler latency. The mechanism is decided by a follow-up task from the first production receipt. Warming-up/sync-failed copy and Part B still ship (independently justified). |
| R1 | Loop delay > 1 s, time-correlated with embed bursts, CPU not saturated | Cooperative yield/pacing in the sync loop between passages |
| R2 | Loop delay ≤ 1 s but handler latency > 1 s while CPU is pegged by onnxruntime intra-op threads during embed bursts | Bound the embedder's CPU footprint (intra-op thread cap and/or serialized batch pacing with idle gaps); worker-thread embedder only if this cannot meet the bound |
| R3 | Delays clustered at index save/load (JSON stringify/parse) | Non-stalling store I/O (Part B's AC-6 contract, pulled forward) |
| R4 | Delays clustered at Jira/Confluence fetch or parse of large documents | Doc-boundary pacing / off-loop handling of large payloads |
| R5 | Delays in the Slack client receive path under load | Bound/pace adapter receive processing during syncs |
| R6 | DNS/threadpool starvation signatures (ENOTFOUND spikes; loop itself fine) | Connection keepalive / DNS caching / threadpool sizing for sync fetches |

## Evidence verified (load-bearing premises at HEAD ce7ca55)

| Premise | Verified |
|---|---|
| Channels report "listening" BEFORE any sync completes | `src/index.ts` — `runMonday` starts `startKnowledgeSources` (background), then `adapter.start()` + "Monday is listening", then Telegram; `sources.ready` is never awaited before answering |
| Initial + scheduled + on-demand syncs all re-embed everything | `src/knowledge/startup.ts` (initial promises, 6 h `DEFAULT_SYNC_INTERVAL_MS` timers, `reindexAll`/`syncConfluence`); `src/knowledge/service.ts` `indexConfluencePage` does `removeBySource(source)` then re-adds EVERY passage |
| Per-embed main-thread blocking is REFUTED on this machine (darwin, Node 24, onnxruntime-node backend) | r1 review probe (`tmp/measure-embed.mjs`, uncommitted): 13–15 ms per 900-char embed via the exact production pipeline; 60 sequential awaits with a 250 ms heartbeat → max timer wake delay 0.1 ms. The 4-minute deafness has an UNPROVEN cause at the embed layer; hence diagnose-first |
| jest CANNOT measure any responsiveness bound | `jest.config.js` moduleNameMapper maps `@xenova/transformers` → `tests/__stubs__/xenova-transformers.js`, a synchronous hash embedder that never blocks; `tests/embed.test.ts` runs ~1 s against that stub — round 1's claim that it exercised the real model was FALSE. All bounds therefore live in the plain-node runner |
| The index is in-memory only; save/load exist but are DEAD CODE in production | `src/index/vectorIndex.ts` `save`/`load` are synchronous full-JSON (`writeFileSync`/`readFileSync` + `JSON.stringify`/`parse` of every chunk plus every 384-dim vector); the only production constructor is `service.ts:148` — nothing calls save/load |
| Save/load round-trip + guards are already tested | `tests/vectorIndex.test.ts` — fidelity round-trip, model-mismatch rejection, corrupt-length rejection, ranking-order preservation |
| Both channels share one query funnel | `src/telegram/adapter.ts:21` imports `handleQuery` from `src/slack/queryHandler.ts`; Slack `app_mention` + `/ask` use the same — one fix covers both |
| Empty index currently answers "couldn't find any relevant information" | `src/knowledge/service.ts` `NO_DOCUMENTS_ANSWER` — false negative during first boot |
| Production services are injectable without jest | `KnowledgeService` constructor takes `index`/`ingest`/`generator` (`src/knowledge/service.ts:147`); sync tests stub fetchers via opts (`tests/knowledge-sources.startup.test.ts`, zero network) — the plain-node runner reuses exactly this seam |
| `.monday-cache/` is NOT in `.gitignore` today | verified r1 — Part B adds the line (named edit site) |

Doc volumes (~895 / ~306) are operator-observed numbers from the ticket, not re-derived here; smokes scale them to fixtures.

## Design decisions (what, not how)

1. **Diagnose before mechanism.** The probe (`scripts/sync-responsive-smoke.js probe`) is Part A's FIRST commit and changes no production behavior — running it before the mechanism diff is running it at HEAD. Its receipt is the baseline that (a) picks the decision-rule row, (b) proves whether the ≤ 1 s bound can fail at HEAD (AC-5's non-vacuity), and (c) under R0, replaces the mechanism leg with production instrumentation. No mechanism ships without a receipt.
2. **Every measured bound runs outside jest, on the real backend.** jest's moduleNameMapper stubs the embedder with code that cannot block, so a jest-measured loop/handler bound passes at HEAD and guards nothing. The standalone runner (plain `node`, real `@xenova/transformers` → onnxruntime-node on darwin) drives the production sync path (`ConfluenceSync`/`JiraSync` + `KnowledgeService`) over checked-in fixtures with stub fetchers and a stub generator injected through constructor opts — no jest machinery, no real Jira/Confluence/Slack/Telegram/Anthropic call.
3. **YES to "still warming up" — bounded, plus a sync-failed copy.** Only while the index is EMPTY and an initial sync is IN FLIGHT does `query()` return the warming-up copy; once any documents are indexed, questions answer normally from what is there (partial beats refusal); when the initial sync FAILED (errors caught, `ready` still resolves, index empty with nothing in flight) a distinct sync-failed copy answers — the false "couldn't find any relevant information" copy is never served in either empty state; with NO sources configured at all the old copy stays, so a misconfigured bot cannot hide behind "warming up". Both channels get it via the shared `handleQuery` funnel.
4. **The persisted index is the cache; "unchanged" = same source id + hash(passage text + title/heading) + same embedding model.** Passage text in the hash means a body edit can never masquerade as unchanged; title/heading in the hash means a title-only edit re-embeds (cheap, rare) instead of serving stale heading metadata forever.
5. **Deletions propagate; growth is bounded by the live corpus.** After each sync, any source absent from that sync's upstream fetch is removed from the live index, and the next save drops its chunks from the store — the bot must not cite deleted documents indefinitely, and the store carries no orphans (asserted as count equality, AC-11). Operator remedy retained: delete the store dir = full rebuild.
6. **Store I/O is non-stalling by contract, not by mechanism.** Chunked-async vs binary serialization is the executor's choice; the contract is the measured bound: ≥ 5,000 passages / ≥ 20 MB store → max event-loop delay ≤ 250 ms per save AND per load (AC-6). Writes are atomic (temp file + rename) so a crash mid-write cannot produce the corrupt case in the first place.
7. **Model change invalidates everything.** Store files carry `EMBEDDING_MODEL`; mismatch on load → discard the whole store, one WARN line, full re-embed via the normal sync path (the existing `load()` model guard already throws; production wiring catches and rebuilds).
8. **Corrupt or missing store → full re-embed, never a crash, never a silently empty index.** Any parse/shape failure (truncated JSON, length mismatch, missing dir) is caught, logged once, and treated as absent: boot proceeds, the sync repopulates, and the warming-up/sync-failed copy covers the gap.
9. **Warm start serves last-known-good between load and first sync completion.** After a restart, queries may briefly see the persisted index (at most one restart old) while the initial sync refreshes it. Accepted tradeoff: a seconds-stale answer beats deafness or a false "nothing found".
10. **Quality = retrieval identity; the generator is untouched.** Parity is asserted through `KnowledgeService.retrieve()` (the production ranking path — expansion, doc-prior, diversity cap all in play), with the LLM stubbed. Cache-hit vectors must equal freshly embedded vectors to numerical epsilon; ordering identical.
11. **Fixtures only; harnesses refuse when their target is unset.** New smokes drive stub fetchers over checked-in fixture documents; no real Jira/Confluence/Slack/Telegram/Anthropic call happens anywhere in them (the local `@xenova` model artifact is the only model touched). The standalone runner refuses with a non-zero exit and an explicit message when `SMOKE_FIXTURES` is unset — it never falls back to a live target (standing rule).
12. **Split into two independently shippable parts, A then B.** Not in scope: worker-thread/remote embedding (unless rule R2 selects it and thread-cap/pacing cannot meet the bound), cursor-pagination changes, any `.env` change, any prompt/model change, restarting or redeploying the live bot (ship-tail concern).

## Size + split — this is L, not M

Two orthogonal mechanisms (measured responsiveness behind a diagnosis gate + a persisted cache with invalidation/deletion/fallback semantics), production wiring across `embeddings`, `index/vectorIndex.ts`, `knowledge/service.ts`, `knowledge/startup.ts`, `index.ts`, a new jest suite + standalone runner, blast radius covering BOTH channels. Proposed split, one PR each, same ticket:

- **Part A — responsiveness (PR 1):** the probe runner + refuse rule (AC-2, AC-4), then the decision-rule row's fix — or, under R0, the production instrumentation leg (AC-5) — plus the warming-up and sync-failed answers (AC-3). Independently valuable: it either ends the operator-visible deafness or produces the receipt that explains it.
- **Part B — persisted index cache (PR 2):** warm start on boot, unchanged-doc skip, deletion propagation, invalidation + fallback, non-stalling store I/O (AC-6..AC-12), parity (AC-12), no-real-services grep (AC-13); also adds `.monday-cache/` to `.gitignore`. Depends on Part A only for the warming/sync-failed copy covering its fallback gap.

### Binary AC (checkable from OUTSIDE the diff; run from the worktree root; `tests/fixtures/sync-responsive/` is the new checked-in fixture corpus — ≥ 60 docs / ≥ 300 passages; `scripts/sync-responsive-smoke.js` is the new plain-node runner with modes `probe` / `bound` / `store`, real embedding backend; `tests/sync-responsive.smoke.test.ts` matches jest's `testMatch ["<rootDir>/tests/**/*.test.ts"]`)

| # | Part | Check | Pass condition |
|---|---|---|---|
| AC-1 | A+B | `npm run typecheck && npm test` | both exit 0 |
| AC-2 | A | `node scripts/sync-responsive-smoke.js probe` with `SMOKE_FIXTURES` unset, then `SMOKE_FIXTURES=tests/fixtures/sync-responsive node scripts/sync-responsive-smoke.js probe` (run on the probe-only first commit, BEFORE any production change) | unset: exit ≥ 1 AND output names the unset fixture target; set: exit 0 with a stdout receipt printing passage count, max + p99 event-loop delay, max handler latency per channel stand-in, and exactly ONE `dominant-stall:` line naming one decision-rule row R0–R6 |
| AC-3 | A | `npm test -- tests/sync-responsive.smoke.test.ts -t warming` AND `command grep -rn "still warming up" src/` | exit 0 with all four cases: empty index + in-flight initial sync → answer matches /warming up/ and does NOT contain "couldn't find any relevant information"; sync settled with docs → normal answer; no sources configured → old copy retained; initial-sync fetchers REJECT → a distinct sync-failed copy, still NOT the "couldn't find" copy; grep prints ≥ 1 hit in src/ |
| AC-4 | A | `node scripts/sync-responsive-smoke.js bound` and `node scripts/sync-responsive-smoke.js store`, each with `SMOKE_FIXTURES` unset | each exits ≥ 1 AND output names the unset fixture target (refuses; never falls back to a live target) |
| AC-5 | A | `SMOKE_FIXTURES=tests/fixtures/sync-responsive node scripts/sync-responsive-smoke.js bound` | exit 0: full fixture-corpus re-sync through the production sync path with the REAL embedding backend; max handler latency ≤ 1000 ms AND max event-loop delay ≤ 1000 ms; a `query()` (stub generator) issued mid-sync resolves BEFORE the sync completes. Non-vacuity: this mode shares the probe's measurement core and runs OUTSIDE jest (whose stubbed embedder cannot block), so at HEAD it fails whenever the stall is real — the AC-2 HEAD receipt is the baseline proof; if that receipt is R0 (stall not reproduced locally), this AC is N/A, the R0 instrumentation leg ships instead, and the bound is never claimed on the stub |
| AC-6 | B | `SMOKE_FIXTURES=tests/fixtures/sync-responsive node scripts/sync-responsive-smoke.js store` | exit 0: store built from the fixture corpus replicated at runtime to ≥ 5,000 passages and ≥ 20 MB (receipt prints measured passages + bytes); max event-loop delay ≤ 250 ms during one full save AND one full load; exit non-zero on violation |
| AC-7 | B | `npm test -- tests/sync-responsive.smoke.test.ts -t "embedding cache"` | exit 0; restart simulated as save → new index/service instance → load: re-sync of the SAME fixture corpus triggers ZERO chunk-embedding calls for unchanged docs (spy on the embedding entry point), and the reloaded index answers queries |
| AC-8 | B | same suite, `-t "embedding cache"` | exactly one fixture document edited between syncs → the embedding-call delta equals THAT document's passage count and nothing else's; all other docs zero |
| AC-9 | B | same suite, `-t model` | persisted store stamped with a foreign model id → discarded at load, full re-embed repopulates the index, exactly ONE warn-level log line, zero thrown/unhandled errors |
| AC-10 | B | same suite, `-t fallback` | BOTH a truncated/garbage store AND a missing store dir → boot continues, the sync repopulates, `query()` returns an answer, no unhandled rejection, one fallback log line per case |
| AC-11 | B | same suite, `-t deletion` | one fixture document removed from the fixture source between syncs → after re-sync + save + reload: ZERO chunks for that source in the live index AND in the reloaded store; reloaded store chunk count == live corpus chunk count (no orphans — growth bounded by the live corpus) |
| AC-12 | B | same suite, `-t parity` | for the fixed corpus + ≥ 8 fixture questions, `retrieve()` (production path, default topK 12) from the cache-warm index returns the SAME chunk ids, sources and order as a freshly embedded index, scores within 1e-6 |
| AC-13 | A+B | `command grep -rnE "globalThis\.fetch|new Anthropic|@slack/bolt|@anthropic-ai/sdk" tests/sync-responsive.smoke.test.ts scripts/sync-responsive-smoke.js` | exit 1 (zero matches — fixture-only; injected stubs that throw-if-called are asserted inside the suite and runner) |

## Risks

| Risk | Mitigation |
|---|---|
| Stall NOT reproducible at fixture scale on this machine (likely, per the r1 probe) | Decision-rule R0: mechanism leg cancelled, instrumentation leg ships (loop delay + handler latency logged during every production sync); the fix is decided from the first production receipt, never shipped unproven |
| Real-corpus stall source differs from the fixture classification | Production instrumentation (the R0 leg's content) + ship-tail operator check of the launchd log confirm on the live box; decision rule re-applied to that receipt |
| Pacing/yield lengthens total sync wall-clock (same CPU, spread out) | Accepted — the defect is deafness, not duration; Part B removes most of the re-embed work anyway |
| Fixture bound met but the real ~1,200-doc corpus still shows > 1 s gaps (e.g. one monster passage) | Passage size is already bounded by the chunker (`maxChars` ~900); escalate to the deferred worker-thread follow-up if observed |
| Store I/O bound unmeetable with decimal-JSON vectors at 5k+ passages | Decision 6 leaves chunked-async vs binary (Float32/base64) serialization open; the AC-6 bound is the contract either way |
| Cache-warm answers are one restart stale between load and first sync | Decision 9 — accepted, bounded, better than the alternatives; warming/sync-failed copy covers the truly-empty case |
| Two processes sharing one data dir corrupt each other | Out of scope — launchd runs a single instance; atomic write + corrupt-fallback contain the damage regardless |
| `removeBySource` + re-add churn defeats the skip (everything re-embedded anyway) | AC-7/AC-8 assert the spy count — the skip must actually prevent the embed calls, not just the wall-clock |
| First bound run fetches MiniLM weights | One-time local model-artifact fetch (cached thereafter), the same artifact the jest stub stands in for; no new external service dependency |

## Deferred-follow-ups:

- Worker-thread (or subprocess) embedder to take embedding fully off-thread — DEFERRED unless decision-rule row R2 is selected AND thread-cap/pacing cannot meet the ≤ 1 s bound.
- Exposing warming/sync state on `/status-monday` — DEFERRED; none.
- Store compaction as its own concern — ABSORBED by deletion propagation (decision 5); only crash-window orphans remain, and the next successful save drops them.

## Round 2 changes

| Finding (r1 review) | Severity | Fix in this revision |
|---|---|---|
| F1 — premise "embeddings block the main thread" refuted by execution (13–15 ms/embed off-thread; wake delay 0.1 ms) | BLOCKER | Plan re-founded as diagnose-first: Intent 1 + Decision 1 + the decision-rule table (R0–R6 map each measured stall source — onnxruntime intra-op CPU saturation, sync JSON save/load, Jira/Confluence fetch/parse, Slack client under load, DNS/threadpool starvation — to its fix); AC-2 receipts the HEAD measurement and classification before any mechanism exists. Cooperative yielding is demoted from premise to row R1's outcome. |
| F2 — ≤ 1 s bound vacuous: jest stubs the embedder; the one real-model runner lacked the bound | BLOCKER | All bounds moved to the plain-node runner with the real onnxruntime-node backend (Decision 2; AC-5 names runner, backend, and non-vacuity — same measurement core as the HEAD probe, fails at HEAD whenever the stall is real; the R0 escape hatch forbids ever claiming the bound on the stub). The false Evidence row about `tests/embed.test.ts` is corrected (it runs the stub). |
| F3 — `tests/sync-responsive.smoke.ts` not matched by jest `testMatch` | HIGH | Jest file renamed `tests/sync-responsive.smoke.test.ts` (matches `["<rootDir>/tests/**/*.test.ts"]`); every jest AC names it; runner ACs name their own `node scripts/...` command. |
| F4 — sync full-JSON save/load reintroduce multi-second loop stalls at real-corpus scale | MEDIUM | Decision 6 + AC-6: `store` runner mode measures at ≥ 5,000 passages / ≥ 20 MB (size bound stated and printed); ≤ 250 ms loop delay per save and per load; mechanism (chunked-async or binary) left open, the bound is the contract. |
| F5 — deleted docs served forever; cache grows without bound | MEDIUM | Decision 5 + AC-11: sources absent from a sync's fetch are removed from index and store; store chunk count asserted equal to the live corpus (growth bound = live corpus); delete-the-store-dir remedy stated; the old "compaction" deferral absorbed. |
| F6a — sources configured but initial sync fails → false "couldn't find" forever | MINOR | Decision 3 + AC-3 fourth case: distinct sync-failed copy. |
| F6b — title-only edit leaves hash unchanged → stale heading metadata | MINOR | Decision 4: hash covers passage text AND title/heading. |
| F7 — `.monday-cache/` not gitignored; worker-thread deferral rested on the refuted premise | MINOR | The gitignore line is named as a Part B edit site (split section); the worker-thread deferral is now conditional on rule row R2 (Deferred-follow-ups). The review's DNS analysis is folded into the probe measuring BOTH loop delay and handler latency (covers R6 callback processing). |

## Planner runs

DISPATCH-NONCE:OR-NONCE-14f1a69fef4e6ef6
DISPATCH-NONCE:OR-NONCE-bbe7faa99f8191e8
