# 3286 plan-review (round 1) — sync-responsive

Reviewer: plan-review, dispatch OR-NONCE-9184fbf7c3883b01, at HEAD 5dae461 (plan a8d1cac).
Seat rules: `tools/openrouter-briefs/seat-rules.md` does not exist in this worktree (checked
via Glob + cat); no guard blocked any command during this review. Cairn searched from the
ai-brain primary (`../../../../ai-brain/skills/cairn/bin/cairn-find.mjs "monday"`); the T1
stone (2026-10-18 line 362, "Monday bot goes deaf for minutes after every restart") matches the
plan's cited symptom. No T1/T2 stone contradicts the approach.

All premises below were verified by execution on this machine (darwin, Node 24) unless marked
code-reading-only.

## Review

DISPATCH-NONCE:OR-NONCE-9184fbf7c3883b01

Decision: NEEDS-WORK

### Finding 1 — BLOCKER. Part A's causal premise ("embeddings block the main thread") is refuted by execution on this machine; the responsiveness defect is not reproduced at the embedding layer.

The plan's core mechanism claim (Evidence table, row 3; ELI5; Intent) is that the local
embedding model "monopolizes the main thread". Executed probe of the exact production path
(`pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")` + `extractor(passage, {pooling:
"mean", normalize: true})` on a 900-char passage, matching `src/embeddings/embed.ts:37`), with
`onnxruntime-node` 1.14 darwin binaries installed (the only backend that loads here):

- single 900-char embed: **13–15 ms**, off-thread;
- tight loop of 60 sequential `await extractor(...)` calls with a 250 ms heartbeat + immediate
  wake-delay probe: **max timer wake delay 0.1 ms** — the event loop turns freely at HEAD,
  with no cooperative-yield mechanism at all.

The production code *already* awaits `embed()` per chunk (`src/index/vectorIndex.ts:57`,
`VectorIndex.add` loop), so "cooperative yielding between passage embeddings" is close to a
no-op: the await points the plan wants to add already exist. If the operator's 4-minute deafness
is real (the T1 stone says it is, with `pong wasn't received` and `getaddrinfo ENOTFOUND`), then
on a darwin-class deployment the cause is NOT per-call main-thread blocking in `embed()` — it
must be something else (CPU saturation from onnxruntime intra-op threads, a WASM-backend
fallback on the deployment box, the Slack client under sustained load, or a stall elsewhere
entirely). The plan ships a mechanism without a reproduction. Required before Part A is sound:
a defect-reproduction receipt at HEAD from the actual deployment — e.g. a `monitorEventLoopDelay`
(or heartbeat) log captured during a real re-sync showing the >1 s stalls the ticket claims — or
a re-diagnosis of where the loop actually stalls. Probe script preserved at
`tmp/measure-embed.mjs` (uncommitted, gitignored).

### Finding 2 — BLOCKER. AC-2's ≤1 s measurement is vacuous twice over: jest stubs the embedder, and even the real backend yields.

`jest.config.js` moduleNameMapper maps `@xenova/transformers` →
`tests/__stubs__/xenova-transformers.js` (a synchronous hash embedder). The stub's own header
says: "The real ONNX model runs in production and is exercised end-to-end by the US-03 AC inline
node commands, **not by jest specs**." Consequences:

- The plan's Evidence row "Real local-model tests are the established pattern —
  `tests/embed.test.ts` … the suite already exercises the local MiniLM model" is **false**.
  Verified: `npx jest tests/embed.test.ts` completes in 1.0 s total — it is exercising the stub.
- AC-2 (`npm test -- tests/sync-responsive.smoke.ts -t heartbeat`, "max observed delay ≤ 1000
  ms") will therefore run against an embedder that never blocks the loop and takes microseconds:
  it passes at HEAD, before any fix. A measured contract that cannot fail on the unfixed code is
  not a contract — AC-2 cannot detect the defect it exists to guard.
- The only real-model harness in the plan is the standalone runner (AC-4, plain node — good),
  but its stated pass condition ("exit 0 on the fixture-only heartbeat workload") does not
  state the ≤1 s bound, so the one place the real model runs may not measure the one number the
  plan is about.

Required: move the ≤1 s bound (and the mid-sync `query()` resolves check) to the plain-node
standalone runner with the real model, and record a "fails at HEAD" receipt — or show it does
NOT fail at HEAD, which per Finding 1 is likely on darwin and is itself decisive diagnostic
information. Fixing this also resolves the false Evidence row.

### Finding 3 — HIGH. ACs 2, 3, 5–9 name `tests/sync-responsive.smoke.ts`, which jest's testMatch does not match; the plan never lists a jest.config.js change.

`jest.config.js` testMatch is `["<rootDir>/tests/**/*.test.ts"]`. A file named
`sync-responsive.smoke.ts` does not match; a positional pattern that matches nothing exits 1
(verified: `npx jest tests/sync-responsive.smoke.ts` → exit 1, "No tests found"). As written,
six of ten ACs fail against the implemented diff unless the executor also edits jest.config.js —
a change outside the plan's stated blast radius. Trivial fix: name the file
`tests/sync-responsive.smoke.test.ts` (or extend testMatch explicitly in the plan).

### Finding 4 — MEDIUM. Part B's save/load are synchronous full-JSON fs ops; at real-corpus scale they reintroduce multi-second main-thread stalls — the exact symptom class the ticket is about.

`src/index/vectorIndex.ts` `save()`/`load()` use `writeFileSync`/`readFileSync` +
`JSON.stringify/parse` of every chunk plus every 384-dim vector as decimal JSON text. At the
ticket's real volume (~1,201 docs; if passage-chunked like the fixtures, plausibly 5–12k
passages) the store is tens of MB; a synchronous parse at boot and a synchronous stringify+write
at each sync-save can each block the loop for seconds — a smaller repeat of the 4-minute
deafness, now happening at every save. The plan's ACs only measure the 60-doc fixture, where
this is invisible. The plan should either (a) specify async/chunked or binary (Float32/base64)
serialization and/or a measured save/load bound, or (b) explicitly accept and bound the one-shot
boot cost. Also note: today's `save()` is NOT atomic (direct `writeFileSync`); the plan's
"atomic (temp + rename)" is new work it correctly takes credit for, but the sync-blocking aspect
is unaddressed.

### Finding 5 — MEDIUM. Deleted-doc handling is a correctness gap, not just a size concern: the skip-only cache serves stale chunks forever and grows without bound.

Part B's sync semantics: source in loaded index + manifest hash match → skip. A document deleted
upstream never appears in the fetch, so nothing ever removes its chunks — they survive in the
live index and are re-saved to the store on every save, meaning the bot cites deleted documents
indefinitely. The plan defers "compacting the store" as a size problem; it is also a staleness
problem (wrong answers, not just a bigger file). At minimum the plan should state this
consequence explicitly and give the operator a cheap remedy (e.g. delete the store dir = full
rebuild) — and this should be carried to execution-review.

### Finding 6 — MINOR. Warming-up answer: two uncovered edges.

(a) Sources configured but the initial sync *fails* (errors are caught and `ready` still
resolves — `src/knowledge/startup.ts` initial-sync `.catch`): index empty, nothing "in flight",
so the user gets the old false "couldn't find any relevant information" copy forever — the exact
false negative the warming-up answer was added to fix, in the state where the index will never
fill. A "sync failed" third copy (or retaining warming copy on last-sync-error) closes it.
(b) Decision 2 hashes passage text; a title-only edit leaves passages unchanged → hash matches →
skip → stale `heading` metadata served. Harmless for ranking, but say so or fold title into the
hash.

### Finding 7 — MINOR. Small accuracy nits, none blocking.

- `.monday-cache/` is NOT currently in `.gitignore` (verified) — Part B must add it; the plan
  says "gitignored" as if existing. One line, just name it as an edit site.
- AC-10's grep is fine and runnable; AC-1, AC-4 (refuse-when-unset with non-zero exit naming the
  target) are fine and match the standing rule.
- DNS/threadpool question from the dispatch: bounding event-loop wake delay is the right proxy —
  `dns.lookup` resolves on the libuv threadpool and its callback runs on the loop, so a ≤1 s
  loop-delay bound covers callback processing; embedding (off-thread, per Finding 1) does not
  consume threadpool threads. The `ENOTFOUND` logs therefore also point at a cause other than
  per-call embed blocking — consistent with Finding 1.
- Worker-thread deferral: given Finding 1, the deferral question inverts — the plan defers a
  worker on the premise that cooperative yielding suffices against main-thread blocking; since
  the blocking was not reproduced here, the deferral rests on an unverified premise, not a
  measured one. Re-decide after the Finding-1 receipt exists.

### What checked out (verified, no action)

- Warming-up bounded as claimed: fires only on empty index + in-flight initial sync; once
  non-empty it can never hide a real "no results" (`src/knowledge/service.ts` `query()` gates on
  `vectorIndex.size() === 0`); both channels share `handleQuery`
  (`src/telegram/adapter.ts:21`) so one fix covers both.
- Model-change invalidation: `load()` throws on model mismatch, corrupt-length guard present
  (`src/index/vectorIndex.ts`), and the round-trip behavior is tested in `tests/vectorIndex.test.ts`.
- Sync-path structure: Confluence sync iterates pages sequentially through
  `indexConfluencePage` (replace-on-resync via `removeBySource`) — per-doc skip points are real.
- Jest accepts the `-t heartbeat` filter form; npm script wiring is compatible.
- The A/B split structure is sound *as a split* (Part B's fallback gap genuinely needs Part A's
  warming copy); its honesty hinges entirely on Finding 1's premise, hence the blocker sits
  there rather than on the split itself.

### Verdict rationale

NEEDS-WORK: Findings 1+2 must be resolved before Part A means anything — the plan measures a
bound that its own test environment cannot falsify, and the causal story it treats as verified
did not survive a 20-line execution probe on the machine class available here. Findings 3–5 are
cheap to fix in the plan text now and expensive to discover during execution.
