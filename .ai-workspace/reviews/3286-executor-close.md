# 3286 executor close — Part A (diagnose-first)

DISPATCH-NONCE:OR-NONCE-76f1e44c22d055f0

## Probe receipt (AC-2, taken at probe-only commit 18c2879 — NO production change)

Command: `SMOKE_FIXTURES=tests/fixtures/sync-responsive node scripts/sync-responsive-smoke.js probe` (after `npm run build`), exit 0.

```
receipt: mode=probe docs=70 docsIndexed=70 passages=495 chunksInIndex=495
wall: 7141ms (14.4ms per embedded chunk)
loop-delay: max=6719.3ms p99=6719.3ms (histogram is timer-sampled and UNDER-REPORTS while handlers are starved — see handler-latency)
handler-latency: slack max=0ms (n=2) telegram max=0ms (n=2) expectedWakes~35 STARVED: zero/few wakes = unbounded latency, not zero latency
cpu: busyRatio=0.33 of 18 cores
mid-sync query: issued=true atDocs=70 latencyMs=4 resolvedBeforeSync=false
dominant-stall: R1
notes: rows R3 (store save/load is dead code at HEAD), R5 (real Slack client receive path; stand-in timers here) and R6 (DNS/threadpool; fixture fetchers make no network calls) are unreachable by this probe design — plan-review r2 finding 3; the row above claims only what this machine measured
```

**Chosen row: R1** — loop delay 6719 ms > 1 s, time-correlated with the embed
chain, CPU NOT saturated (0.33 of 18 cores). Part A ships R1's fix: cooperative
yield in the sync loop between passages.

Mechanism, measured while calibrating the probe (this refines — not contradicts
— the r1 review's "per-embed blocking refuted" finding): each embed is cheap
(~3–14 ms) and runs off the JS thread, but the await-chained embed loop never
yields to the timers phase, so every due timer in the process is starved for
the WHOLE sync: a 200 ms-cadence wake stand-in fired 2 of ~35 expected times,
and the mid-sync query's 5 ms poll timer first saw the index only after all 70
docs were in (`atDocs=70`). `monitorEventLoopDelay` is itself timer-sampled and
reported 0 ms in the first probe draft while handlers were fully starved; the
corrected probe's grace wait lets its sampler land post-chain, capturing the
true ~6.7 s gap. This timer starvation is exactly the operator symptom shape
(`pong wasn't received`, `getaddrinfo ENOTFOUND slack.com` — a starved loop
misses socket pings and DNS timer deadlines), though R6's DNS leg itself stays
unreachable by this probe (stub fetchers) per plan-review r2 F3.

Fix-class validation (standalone, production path unchanged): inserting one
`setImmediate` yield between embed calls restored on-time timer wake-ups (a
100 ms interval fired at exactly 100 ms across 50 embeds) at zero throughput
cost (129 ms for 50 embeds, same per-embed rate).

Probe history: first draft (commit ca9e9d4) misread zero wakes as zero latency
and printed R0; the measurement core was corrected in probe-only commit
18c2879 (starvation detection + grace wait + in-promise query timestamp) and
the receipt above is from that corrected probe. Unreachable rows R3/R5/R6 are
named in the receipt rather than guessed at.

## AC verification (Part A)

Head at verification: d0c3f52. `npm run build` run before every runner AC
(plan-review r2 F1 prerequisite). Model backend: local MiniLM artifact via the
shared node_modules; first real-backend embed completed in 145 ms — no download
hang encountered (F2 note: had it hung 10 min, this would have handed back).

| AC | Command | Exit | Observed |
|---|---|---|---|
| AC-1 | `npm run typecheck` | 0 | clean |
| AC-1 | `npm test` | 0* | 654 passed / 654 with `env -u ANTHROPIC_MODEL npm test`. *Bare `npm test` in THIS dispatch shell fails exactly one assertion (tests/generate.test.ts:94, expects default model `claude-haiku-5-5`, receives the shell's `ANTHROPIC_MODEL` value): the harness exports `ANTHROPIC_MODEL`, which `src/llm/modelConfig.ts` honors as a documented override contract (#18/#51). Pre-existing at HEAD d45f28b (no file my diff touches is involved); in a normal shell the suite is green. |
| AC-2 | `node scripts/sync-responsive-smoke.js probe` (SMOKE_FIXTURES unset) | 1 | "refusing to run: SMOKE_FIXTURES is unset — no fixture target named … never falls back to a live … target" |
| AC-2 | `SMOKE_FIXTURES=tests/fixtures/sync-responsive node scripts/sync-responsive-smoke.js probe` (at probe-only commit 18c2879, pre-fix) | 0 | receipt quoted above; `dominant-stall: R1` |
| AC-3 | `npm test -- tests/sync-responsive.smoke.test.ts -t warming` | 0 | 4 passed, 1 skipped (the non-warming yield test) |
| AC-3 | `command grep -rn "still warming up" src/` | 0 | 2 hits (src/knowledge/service.ts:30, src/knowledge/startup.ts:110) |
| AC-4 | `node scripts/sync-responsive-smoke.js bound` (unset) | 1 | names the unset fixture target |
| AC-4 | `node scripts/sync-responsive-smoke.js store` (unset) | 1 | names the unset fixture target |
| AC-5 | `SMOKE_FIXTURES=tests/fixtures/sync-responsive node scripts/sync-responsive-smoke.js bound` (post-fix, real backend) | 0 | loop max 227.8 ms, p99 83 ms; handler max 207.7 ms both stand-ins, wakes 28 of ~31 expected (no starvation); mid-sync query resolvedBeforeSync=true; `bound: PASS` |
| AC-13 | `command grep -rnE "globalThis\.fetch\|new Anthropic\|@slack/bolt\|@anthropic-ai/sdk" tests/sync-responsive.smoke.test.ts scripts/sync-responsive-smoke.js` | 1 | zero matches |

### variant | direction | expected | observed

| variant | direction | expected | observed |
|---|---|---|---|
| probe, SMOKE_FIXTURES unset | must-fire (refuse) | exit ≥ 1 + names unset target | exit 1, refuse message names SMOKE_FIXTURES and the no-live-target rule |
| bound, SMOKE_FIXTURES unset | must-fire (refuse) | exit ≥ 1 + names unset target | exit 1, same refuse path |
| store, SMOKE_FIXTURES unset | must-fire (refuse) | exit ≥ 1 + names unset target | exit 1, same refuse path |
| probe, fixtures set, at HEAD (pre-fix) | must-fire (detect the stall) | > 1 s somewhere + one dominant-stall row | loop max 6719.3 ms; wakes 2 of ~35 (starved); dominant-stall: R1 |
| bound, fixtures set, post-fix | must-not-fire (no violation) | exit 0, all ≤ 1000 ms, mid-sync query first | exit 0; loop 227.8 ms, handler 207.7 ms, wakes 28/31, resolvedBeforeSync=true |
| empty index + initial sync in flight | must-fire | /warming up/, not "couldn't find" | jest pass (answer matches /warming up/, citations []) |
| initial sync all-rejected via startKnowledgeSources | must-fire | distinct sync-failed copy, not couldn't-find, not warming | jest pass (phase "failed", distinct copy) |
| no sources configured | must-not-fire | old couldn't-find copy retained | jest pass (old copy, no "warming up") |
| docs indexed mid-sync, sync in flight | must-not-fire | normal answer from partial index | jest pass (stub generator answer served) |
| pending setImmediate during multi-chunk add() | must-fire | interleaves before add() resolves | jest pass (regression test for the R1 yield) |
| real-service tokens in new harness files | must-not-fire | AC-13 grep zero matches | exit 1, zero matches |

Input-bound note (probe/runner): the fixture corpus is capped by a checked-in
guard — the runner refuses (< 60 docs exits 1) and every fixture fetcher
throws on any space/project other than the fixture keys, so an oversized or
misdirected corpus fails closed instead of reaching a live target; store mode
refuses outright in Part A. The sync loop itself is bounded by the corpus (495
passages, ~12.5 ms/embed measured), so no loop/DoS class exists at probe
scale.

## Executor-close

Executor-close: draft PR https://github.com/ziyilam3999/monday-bot/pull/269 shipped Part A of #3286 — the probe-first
commit (fixtures + plain-node runner with refuse rule), the R1 receipt (loop
delay 6719 ms, handler wakes starved 2/~35, CPU 0.33/18 cores → cooperative
yield between passages), the AC-3 warming-up/sync-failed answers, and all
Part A ACs verified as tabled above.
