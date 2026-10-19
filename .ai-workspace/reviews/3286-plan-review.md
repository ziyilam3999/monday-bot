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

## Review

DISPATCH-NONCE:OR-NONCE-f24b427a41878c53

Decision: PASS

Round 2 (plan 90d30f0). Scope held to the round-2 contract: re-adjudicated each r1 blocker's fix, verified plan premises by inspection and execution where the sandbox allowed, and re-checked the AC surface. No finding rises to class (a)/(b)/(c).

### Fix adjudication (r1 F1–F7)

- **F1 (BLOCKER, refuted premise) — CLOSED.** The plan no longer asserts a mechanism. Diagnose-first is structural: Decision 1 makes the probe Part A's first commit with no production change (so the probe run IS a HEAD run), AC-2 receipts it, and the R0–R6 table maps the receipt to a fix or, under R0, cancels the mechanism leg and ships instrumentation instead. Re-checked the rule's totality: with handler stand-ins being loop-scheduled, handler latency ≈ loop delay, so the outcome space reachable by the probe as designed (stub fetchers, no save/load at HEAD) is covered by R0/R1/R2/R4 with no row-less outcome. See finding 3 for the rows the probe cannot reach.
- **F2 (BLOCKER, vacuous bound) — CLOSED.** Re-verified at HEAD: `jest.config.js` moduleNameMapper still stubs `@xenova/transformers` (and Anthropic + Bolt), so no jest-measured bound can falsify anything; every bound now lives in the plain-node runner with the real backend (Decision 2, AC-5 names backend + non-vacuity, and the R0 escape hatch forbids claiming the bound on the stub). Runner-drives-TS is feasible: the repo's established pattern is `npm run build && node scripts/x.js` against `dist/` (`scripts/eval-recall.js` does exactly this). See finding 1.
- **F3 (HIGH, testMatch) — CLOSED, verified.** `tests/sync-responsive.smoke.test.ts` matches `testMatch ["<rootDir>/tests/**/*.test.ts"]`; every jest AC names that file, every runner AC names its own `node scripts/...` command.
- **F4 (MEDIUM, store I/O) — CLOSED.** AC-6 states the scale (≥ 5,000 passages / ≥ 20 MB, printed in the receipt) and the measured contract (≤ 250 ms loop delay per save AND load); mechanism left open (Decision 6). Size figure is realistic: 5k × 384-dim decimal-JSON vectors ≈ tens of MB, matching the dead-code `save()` at `src/index/vectorIndex.ts:119` (verified still dead at HEAD — nothing in `src/` calls save/load).
- **F5 (MEDIUM, deletions/unbounded growth) — CLOSED.** Decision 5 + AC-11: absent sources removed from index and store, reloaded-store chunk count asserted equal to live corpus (count-equality is the right shape — it cannot be gamed by removing only the index side).
- **F6a/F6b/F7 (MINOR) — CLOSED.** Sync-failed copy is AC-3's fourth case; hash covers passage text AND title/heading (Decision 4); `.gitignore` edit site named in the split; worker-thread deferral re-conditioned on R2.

### Findings (none blocking)

1. **MEDIUM — runner commands omit the dist build prerequisite.** AC-2/AC-5/AC-6 invoke `node scripts/sync-responsive-smoke.js ...` bare, but the repo's plain-node scripts require `dist/` (built by `npm run build`; no tsx/ts-node in devDependencies, and no `dist/` exists on a fresh checkout of the probe-only first commit). Executor must pair each runner AC with `npm run build &&` or have the runner verify dist freshness, else the ACs fail environmentally. Carried as NR-3286-R2-build-prereq.
2. **MEDIUM (environmental) — first real-backend run needs the MiniLM artifact fetch.** My re-run of the r1 probe shape (300 passages, real `dist/embeddings/embed.js`, `monitorEventLoopDelay` + per-channel wake stand-ins) hung >10 min at first model load: no `.cache` in this worktree, no onnx artifact anywhere local, sandboxed egress. This does not refute any premise — r1's executed 13–15 ms/embed measurement stands in the plan's evidence table, and the plan's own risk row names this exact one-time fetch — but AC-5/AC-6's first execution needs network or a pre-seeded cache. Carried as NR-3286-R2-model-fetch.
3. **NAMED-RISK — rows R3/R5/R6 are unreachable by the HEAD probe as designed.** Fetchers are stubbed (no DNS → R6 unobservable), `save`/`load` are dead code at HEAD (R3 unobservable pre-Part-B), and handler stand-ins are not the real Slack client receive path (R5). R6 is the row that matches the operator's `getaddrinfo ENOTFOUND slack.com` symptom, so the likely local receipt is R0 and the mechanism decision defers to production instrumentation — which the plan itself provides for (R0 leg + risk row 2), so this is a scoping note, not a hole: the executor must not word the R0 receipt as having "ruled out" DNS/threadpool starvation. Carried as NR-3286-R2-unreachable-rows.
4. **MINOR — AC-7's spy must scope to chunk embedding.** The reloaded index answering queries embeds the *query*; the AC's "ZERO chunk-embedding calls" is decidable only if the spy sits on the chunk-embed call site, not `embed()` globally. The AC text already says "chunk-embedding"; flagging so the executor picks the seam accordingly.
5. **Part A / Part B split — still honest, Part A alone shippable.** The probe changes no production behavior (Decision 1); warming-up/sync-failed copy touches only the empty-index branch of `query()` (`src/knowledge/service.ts:161`); under R0 Part A still ships the instrumentation leg + truthful answers and is independently valuable; Part B's dependency on Part A is exactly the one copy. AC-13's grep plus the injected-stub-that-throws pattern covers the fixture-only rule.

### Execution checks run this round

- `git fetch` + `ff-only` merge: clean at 90d30f0.
- `jest.config.js` testMatch + moduleNameMapper re-verified (F3/F2).
- `src/index.ts` listening-before-sync ordering, `src/telegram/adapter.ts:21` shared `handleQuery`, `vectorIndex.save/load` dead at HEAD with model guard present, `service.ts` constructor injectability + `removeBySource`-then-re-add churn, `NO_DOCUMENTS_ANSWER` at empty index, `.monday-cache` absent from `.gitignore` — all re-verified at HEAD.
- `npx tsc` clean; real-backend probe attempt executed (blocked at model-artifact fetch, see finding 2).

### Verdict rationale

PASS: both r1 blockers are closed structurally (diagnose-first with a total-enough decision rule; every bound off jest and on the real backend), the HIGH and MEDIUM findings are closed with verified ACs, and the remaining notes are execution-environment carries, not plan defects. Part A is safe to ship alone.
