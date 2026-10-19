# 3299 execution review — exact issue-key lookup

Reviewed: branch `3299-key-lookup` at head `2ed8f80` (PR ziyilam3999/monday-bot#270), base `6873485`.
Plan: `.ai-workspace/plans/2026-10-19-3299-key-lookup.md` (plan-review r2 PASS). Source diff: `src/knowledge/keyLookup.ts` (new), `src/knowledge/service.ts`, `src/knowledge/startup.ts`, `src/jira/sync.ts`, `src/index/vectorIndex.ts`, `src/index.ts`; suite `tests/key-lookup.test.ts` + two fixtures.
cairn: searched first (`cairn-find "issue key"`, `cairn-find --task 3299 "vector"`): the T1 defect stone this ticket answers is the top hit; no stone contradicts the approach.

## Evidence I ran myself (logs under `tmp/er-logs/` in the worktree, untracked)

| AC | Command | Result |
|----|---------|--------|
| AC-1 | `npm run typecheck`; `npx jest` (full) | typecheck rc=0; full rc=0, 65 suites / 678 tests passed (no env override set) |
| AC-2 | `npx jest tests/key-lookup.test.ts -t extraction` | rc=0, 7 passed |
| AC-3 | `-t "repro shape"` at head | rc=0, 1 passed |
| AC-3 RED | base worktree at `6873485` (tracked tree clean, `keyLookup.ts` absent), head's suite + both fixtures copied in untracked (byte-compared with `cmp`), `npx jest tests/key-lookup.test.ts -t "repro shape"` | rc=1. Failing assertion: `expect(sources).toContain("jira:DEMO-673")` at `tests/key-lookup.test.ts:317` — Received `["jira:DEMO-680", "jira:DEMO-674", "jira:DEMO-675", ...]`. An assertion failure, not an import error. Matches the executor's receipt |
| AC-4 | `-t indexed` | rc=0, 7 passed (Slack `handleQuery` and Telegram adapter arms both present) |
| AC-5 | `-t live` | rc=0, 2 passed |
| AC-6 | `-t "not found"` | rc=0, 1 passed |
| AC-7 | `-t must-not-fire` | rc=0, 5 passed |
| AC-8 | `-t parity` at head AND at base | rc=0 both. The receipt is true at base too, and `retrieve()` is untouched by the diff |
| AC-9 | the plan's fenced (unescaped) grep over `tests/key-lookup.test.ts` | rc=1, zero matches |
| AC-10 | `-t multi-key` | rc=0, 3 passed |
| AC-11 | `-t timeout` | rc=0, 2 passed |

**Red controls (one-line mutants, isolated scratch copy of src + this suite; the worktree was not edited):**
- M1: delete the line `if (m.shape !== "hyphen" && !hasContextWordBefore(toks, i)) continue;` in `keyLookup.ts` -> suite RED, 3 failed (extraction (c), must-not-fire (2), must-not-fire (3)).
- M2: `MAX_NAMED_KEYS = 3` -> `4` -> suite RED, 1 failed (multi-key (c)).
- M3: `LIVE_LEG_DEADLINE_MS = 10_000` -> `60_000` -> suite stays GREEN (survived; see finding 3).
- Unmutated scratch copy: 24/24 green (control for the harness itself).

**Hardness probes** (extraction run against head code, project list `DEMO`, `OPS`): `COVID-19`, `DEMO-1.2.3`, `demo-2-know`, `v2.0 ... demo 3.5`, bare `673`, `XYZ-673`, `demon-673`, `DEMO-673a`, "Can I demo 2 volunteers..." -> all extract nothing. `DEMO-673`, `ops-42` -> `OPS-42` (case-insensitive match, configured casing), `demo-0673` -> `DEMO-673`, "Can you extract Jira Demo 673?" -> `DEMO-673`, "ticket: DEMO 12" -> `DEMO-12`.

**Code reading:**
- No fixture special-casing in `src/` (no fixture keys, no test-env branches).
- No-key path: `answerWithKeyLookup` with zero extracted keys calls `retrieve()` then `generator(question, hits.map(toLlmChunk))` — the same two calls as base. With no `JIRA_PROJECTS`, `issueLookup` is undefined and extraction never runs.
- Live fetch: `buildIssueFetcher` reuses the shared `fetchPaginatedIssues` (same Basic-auth site, GET only), JQL `key = <KEY>` with `maxResults 1`. The key is built from a configured project key plus a digit run only, so nothing from the question text beyond digits reaches the JQL. Same env var names as the existing Jira sync wiring; no new secret handling. Sequential per-key fetches, each bounded by min(5 s, leg time left); errors and empty results become honest "not found or not visible" lines; expiry becomes "timed out". An all-miss question returns the honest lines with zero citations and no generator call, so no neighbour stand-in.
- Tests use a stubbed fetcher and a stub generator only. AC-9 grep is clean.

## Named-risk dispositions

`node hooks/named-risk-notes.mjs list --task 3299` printed `NO-NOTES 3299` (bare, with `--repo` set to this worktree, and after fetching). The plan review says it registered two notes, but the store does not have them (finding 6). I decided both anyway, as the brief asks:

DISPOSITION 3299-receipt-memorization addressed: I reproduced the AC-3 RED at base myself with the plan's method (assertion failure at line 317, not an import error). The AC-8 parity receipt also passes when run at base, and `retrieve()` is unchanged in the diff, so the receipt is a true base record. `src/` has no fixture-specific branches. Mutants M1 and M2 turn the suite red, so the suite is not satisfied by a memorizing stub.
DISPOSITION 3299-word-context-guard observed-in-diff: YES, it fires. "the key is to demo 3 volunteers on this" extracts `DEMO-3`, and "the issue is we demo 2 days off" extracts `DEMO-2`. The plan's uniform rule allows this and the code comment names it. The impact is bounded and accepted for this ticket (finding 1 has the remedy as a follow-up).

LOW notes from plan-review r2:
- Live-leg composition is named: yes. The `service.ts` constants comment and the `answerWithKeyLookup` / `fetchIssueLive` comments say "sequential, first-mention order, each budgeted min(per-fetch bound, remaining leg time)".
- Prefix matching is case-insensitive with canonical casing: yes. The `canonical` map is keyed by the lowercased prefix and emits the configured spelling (probe `ops-42` -> `OPS-42`; the suite asserts `demo-43` stays lowercase for a lowercase-configured list).

## Monotonicity checklist

- Status arms (`ok` / `miss` / `timeout` / `skipped`) are mutually exclusive per key. The all-miss short-circuit needs `pinned.length === 0`, so the weaker miss claim never erases the stronger found claim (found content). `skipped` (no fetcher configured) adds no miss line, so not having a fetcher never turns into a false "not found".
- Context assembly is `[...pinned, ...vector].slice(0, topK)`. Pinned chunks always come first, so a vector hit can never push out a pinned chunk. Total context size stays the same.
- Timeout vs miss: the timeout label is set only by the private sentinel error message, and every other rejection is a miss. That is the right direction: a real timeout is never reported as found.

## Review

Decision: PASS

All 11 Binary ACs verified by my own runs. The AC-3 RED at base reproduces with the plan's own method. Two one-line mutants turn the suite red. Nothing I found blocks shipping. Findings:

1. **MEDIUM (named risk 3299-word-context-guard, accepted, follow-up)**: prose with an ordinary-English guard word fires a key ("the key is to demo 3 volunteers" -> `DEMO-3`). Usual impact: up to 3 pinned chunks take the tail of the 12-slot context, and the vector answer still runs. Worst impact: if the false key is neither indexed nor returned by Jira, the honest-miss copy REPLACES the real answer. Suggested S follow-up (not this PR): for loose-shape (spaced/fused) keys, a miss should fall back to the vector answer instead of short-circuiting, and/or narrow the guard to `jira`/`ticket` directly before the key.
2. **LOW**: pinned chunks are not de-duplicated against the vector hits. When a named indexed key also ranks in the vector top-12 (bare "DEMO-673" ranks 4th on the real embedder), the same chunk can appear twice in context and citations, wasting a slot.
3. **LOW**: the whole-leg 10 s deadline has no test that tells it apart from the per-fetch bound. Mutant M3 (deadline 60 s) survives, because AC-11(b)'s two 5 s fetches total exactly 10 s anyway. By reading the code the deadline is correct (`remaining` is clamped per fetch), but a 3-key never-resolving arm would pin it.
4. **LOW**: production wiring is not unit-tested. `buildIssueFetcher` (JQL `key = X`, `maxResults 1`, null on empty), `buildIssueLookupFromEnv` (env gating) and `VectorIndex.getChunksBySource` have no direct tests; the suite drives the service through a stub fetcher. The operator's post-deploy Telegram live check (plan section) is the real cover for the REST leg. An abandoned fetch is also not aborted (no AbortController), so it keeps running in the background after the time box. That is acceptable but worth noting.
5. **LOW (cosmetic)**: the new #3299 constants block in `service.ts` was inserted between the existing 3286 JSDoc and `WARMING_UP_ANSWER`, so that JSDoc no longer sits on its constant. Also, configured project keys that contain digits (for example `AB2`) can never match, because the tokenizer splits letters from digits. That case is outside the fixture and the plan.
6. **LOW (process)**: the named-risk store returns `NO-NOTES 3299`, even though plan-review r1/r2 say notes `3299-receipt-memorization` and `3299-word-context-guard` were registered. Both are decided above by id anyway. The registration seems not to have landed in the ai-brain store.
