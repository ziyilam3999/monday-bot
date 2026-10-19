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

(to be filled after the R1 fix lands)

## Executor-close

(to be filled at close)
