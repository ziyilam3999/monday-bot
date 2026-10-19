# 3307 executor close — round 1

DISPATCH-NONCE:OR-NONCE-0d72781b75a95fbe

Branch `3307-issue-meta`, head `6449939` (this file committed with it). Plan r2
(491a01c), plan-review r2 PASS (472de2e). Implementation: the one-issue live
fetcher's field list is widened (`status,assignee,priority,resolution,updated`
added to the same single GET — src/jira/sync.ts `buildIssueFetcher`), the Jira
mapper surfaces an optional `meta` (display-name-only assignee; mapped only for
fields the fetch returned, so the sync fetcher maps none and the indexed body is
unchanged), and `KnowledgeService.answerWithKeyLookup` renders a code-built,
live-labelled facts line per named key from that one fetch — for an INDEXED key
as an extra line beside the index-sourced pins, for an UNINDEXED key from the
same fetch that fills the pin (never two). Miss/error/timeout on an indexed key
keeps the pin and adds the honest could-not-fetch line; "skipped" (no fetcher)
adds nothing — the #3299 answer, verbatim.

One pre-existing suite arm was updated to the new contract (disclosed):
`tests/key-lookup.test.ts` multi-key (b) asserted the indexed key was NEVER
fetched — true under #3299, false by design under #3307 (the indexed key now
gets exactly ONE facts fetch; its pins still come from the index, asserted via
non-`live:` chunk ids).

Seat-rules note: `tools/openrouter-briefs/seat-rules.md` does not exist in this
worktree (searched repo-wide; no `tools/` dir at all) — no seat bans could be
read, nothing enforced. `hooks/3role-ledger.mjs` is likewise absent (verified:
`ls hooks` → No such file or directory; `node hooks/3role-ledger.mjs` fails to
resolve), so the preamble self-append line could not be run — the ledger row is
handed back in the dispatch report instead of fabricated.

## AC table (commands run from the worktree root; logs under tmp/suite-logs/)

| AC | command | exit |
|----|---------|------|
| AC-1 | `npm run typecheck` | 0 |
| AC-1 | `npx jest > tmp/suite-logs/3307-jest.log 2>&1` | 1 — pre-existing only: the session-ambient `ANTHROPIC_MODEL` override (env wins per `resolveModel`) fails `tests/generate.test.ts`'s default-model assertion (`glm-5.3` vs `claude-haiku-5-5`); no llm/modelConfig change in this diff. Per the #3299 convention (empty = unset): `ANTHROPIC_MODEL= npx jest > tmp/suite-logs/3307-jest-unset.log` → 0, **66/66 suites, 688/688 tests** |
| AC-2 | `npx jest tests/key-lookup-meta.test.ts -t "live meta"` | 0 (tmp/suite-logs/3307-head-ac-live meta.log) |
| AC-3 | `npx jest tests/key-lookup-meta.test.ts -t "live preferred"` | 0 (…3307-head-ac-live preferred.log) |
| AC-4 | `npx jest tests/key-lookup-meta.test.ts -t "plain unknown"` | 0 (…3307-head-ac-plain unknown.log) |
| AC-5 | `npx jest tests/key-lookup-meta.test.ts -t "meta failure honest"` | 0 (2 arms: reject + exceeds-box) (…3307-head-ac-meta failure honest.log) |
| AC-6 | `npx jest tests/key-lookup-meta.test.ts -t "parity"` | 0 (…3307-head-ac-parity.log) |
| AC-7 | `npx jest tests/key-lookup-meta.test.ts -t "no fetcher"` | 0 (…3307-head-ac-no fetcher.log) |
| AC-8 | `npx jest tests/key-lookup-meta.test.ts -t "privacy"` | 0 (…3307-head-ac-privacy.log) |
| AC-9 | `npx jest tests/key-lookup-meta.test.ts -t "fields lock" && npx jest tests/jira.test.ts` | 0 and 0 (…3307-head-ac-fields lock.log, …3307-head-jira.log) |
| AC-10 | red-at-base: `git archive origin/master` extracted to tmp/3307-base (pristine `c865a53`), suite + fixtures copied in untracked, node_modules symlinked; the five must-fire `-t` runs each → exit 1 (see table below). Green at head: full suite rc=0. Suite/fixtures mention only the `DEMO` project key |

## Variant table (observed from the real runs above)

| variant | direction | expected | observed |
|---------|-----------|----------|----------|
| `-t "live meta"` @ pristine c865a53 | must-fire (RED) | facts line absent → assertion fails | exit 1 — `toContain("DEMO-673 — Status: In Progress")` failed; answer carried only the #3299 prelude + stub echo (tmp/suite-logs/3307-red-base-live-meta.log) |
| `-t "live meta"` @ head 6449939 | must-fire (GREEN) | every rendered value + live note | exit 0 (tmp/suite-logs/3307-head-ac-live meta.log) |
| `-t "live preferred"` @ base | must-fire (RED) | no live values rendered | exit 1 (tmp/suite-logs/3307-red-base-live-preferred.log) |
| `-t "live preferred"` @ head | must-fire (GREEN) | LIVE values present, stale Done/Old Owner/Low/2026-10-01 absent, pins from index (`indexed copy` text, non-live ids) | exit 0 |
| `-t "plain unknown"` @ base | must-fire (RED) | no plain wordings | exit 1 (tmp/suite-logs/3307-red-base-plain-unknown.log) |
| `-t "plain unknown"` @ head | must-fire (GREEN) | Unassigned / Unresolved, no `Priority:` segment, carried fields present | exit 0 |
| `-t "meta failure honest"` @ base | must-fire (RED) | no could-not-fetch line (base never fetches an indexed key) | exit 1, BOTH arms failed (tmp/suite-logs/3307-red-base-meta-failure.log) |
| `-t "meta failure honest"` @ head | must-fire (GREEN) | pinned retelling + could-not-fetch line, zero fixture meta values | exit 0 |
| `-t "fields lock"` @ base | must-fire (RED) | one-issue fields NOT widened | exit 1 — fields param `summary,description,comment` vs expected widened list, quoted verbatim in the log (tmp/suite-logs/3307-red-base-fields-lock.log) |
| `-t "fields lock"` @ head | must-fire (GREEN) | sync fields exactly `summary,description,comment`; one-issue fields widened; `meta` mapped (display name, nulls kept) | exit 0 |
| `-t "parity"` / `-t "no fetcher"` / `-t "privacy"` @ head | must-not-fire | key-free ask deep-equal (answer+citations+chunks); no-fetcher answer verbatim the generator return; display name rendered, no @-shaped string | exit 0 each |
| RED CONTROL (exercised mutant) | must-fire | wording break must fail the arm | `Assignee: Unassigned` → `Nobody` (one line, src/knowledge/service.ts): `-t "plain unknown"` exit 1 — received line shows `Assignee: Nobody`; restored via `git restore`, rerun exit 0 (tmp/suite-logs/3307-red-control.log, …-restore.log) |

Red-control receipt (mutant run, quoted from tmp/suite-logs/3307-red-control.log):

```
Expected substring: "Assignee: Unassigned"
Received string:    "Answer includes DEMO-673 fetched live from Jira just now (created too recently
for the 6-hourly sync). DEMO-673 — Status: Open · Assignee: Nobody · Resolution: Unresolved ·
Updated: 2026-10-17 (live, fetched from Jira just now). Stub retelling of the pinned chunks."
```

## Named-risk note honored (nr-3307-stale-indexed-as-current)

Verified by reading the diff: the facts line is assembled by CODE
(`renderIssueFactsLine`, src/knowledge/service.ts) from the fetched live fields
only, labelled `(live, fetched from Jira just now)`; the indexed body is pinned
as the ticket's story and is never labelled or presented as current status — the
only copy that references the indexed copy says it "may be stale". The AC-3 arm
asserts the stale values embedded in the indexed body never reach the answer.

## Privacy proofs

- `git diff origin/master...HEAD --unified=0 | command grep -E '^\+' | command grep -c -iE 'get[- ]?[0-9]'` → **0**
- `command grep -rn 'DEMO' src/` → fixture-key convention only (pre-existing base comments + this diff's DEMO-673 examples); no real project key; fixtures carry only `DEMO` and demo@example-style fake values (AC-8 requires an emailAddress shape in the RAW page fixture; the mapper never reads it and the arm asserts no @-shaped string reaches the answer).

Executor-close: PR https://github.com/ziyilam3999/monday-bot/pull/272 (draft,
base master) head 6449939 — widened the one-issue live fetch and added the
code-built live facts line per plan r2, all ten binary ACs green at head with
the RED-at-base receipts and one exercised mutant red control quoted above.
