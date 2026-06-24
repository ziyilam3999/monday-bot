# 1169 — Execution Review (stateless, independent)

Reviewer: stateless execution reviewer (write-capable, did NOT author the code).
Scope: privacy CI gate + .gitignore symlink fix + Layer-B prompt-integrity test.
Diff base: `origin/master...HEAD` (5 impl files + 1 plan doc).

## Verdict

Decision: PASS

## Per-check results (exit codes)

| Check | Command (summarized) | Exit | Result |
|---|---|---|---|
| Build | `npm run build` (tsc) | 0 | clean, no TS errors |
| Full test suite | `npm test` | 0 | 23 suites / 193 tests PASS |
| Prompt-integrity test | `npm test -- generate.prompt-integrity` | 0 | 1 suite / 2 assertions PASS |
| F1 fail-closed (unresolvable base) | `GITHUB_BASE_REF=no-such-ref-xyz ...` | 1 | refuses, NON-vacuous |
| Fail-closed on real hit (FAKE token) | `PRIVACY_DENYLIST_TOKENS=<fake> GITHUB_BASE_REF=master ...` over temp commit | 1 | token scan fired (2 lines) |
| Home-path guard (no secret) | same temp commit, secret unset | 1 | home-path guard fired independently (1 line) |
| Self-pass on real PR diff | `GITHUB_BASE_REF=master ...` | 0 | clean, 292 added lines scanned |
| Post-cleanup self-pass | re-run after reset | 0 | worktree restored, still green |

## F1 (elevated plan-review finding) — non-vacuous fail-closed: CONFIRMED

- Unresolvable base ref → exit 1 with an explicit refusal message ("refusing to
  run on an unresolvable base"). Not a silent pass.
- Empty merge-base path verified by reading the script: after `RANGE_BASE`
  resolves, `MERGE_BASE` is computed; `if [ -z "${MERGE_BASE}" ]` prints an error
  and `exit 1`. So an empty/unresolvable merge-base also fails closed.
- A deliberate FAKE-token hit and an absolute-home-path hit both produced exit 1,
  with matched content WITHHELD from logs (only counts + remediation printed) —
  the gate does not re-leak into CI logs.

## Privacy axis

- No absolute home path in any committed file (grep of added diff lines for the
  `/Users/` or `/home/` + username pattern returns nothing).
- The workflow YAML and the script carry ZERO regulated tokens; tokens are read
  only from the `PRIVACY_DENYLIST_TOKENS` GitHub Actions secret via env.
- The throwaway FAKE-token scenario was reverted (`git reset --hard HEAD~1` +
  removed the temp file); `git status` is clean and HEAD is unchanged from the
  reviewed commit.

## Prompt-test strictness — CONFIRMED

The live system prompt contains the abstain clause "...contains no relevant
information, say you couldn't find the information" and the lead-with-found
clause. The `/no relevant information/i` assertion is uniquely satisfied by the
abstain clause, so deleting that clause fails the test; the lead-with-found
assertion is uniquely satisfied by its clause. Removing either clause trips the
test. Test is non-vacuous.

## Scope — CONFIRMED

Diff touches ONLY: `.github/workflows/privacy.yml`, `scripts/privacy-denylist-check.sh`,
`.gitignore`, `src/llm/generate.ts` (added `export` only — no wording change),
`tests/generate.prompt-integrity.test.ts`, plus the plan doc under
`.ai-workspace/plans/`. Does NOT touch `src/knowledge/startup.ts`, `src/index.ts`,
or `src/slack/adapter.ts`.

## Non-blocking notes

1. The fake placeholder string `FAKEBRANDXYZ` appears once in the committed plan
   doc (documenting the binary AC). It is a deliberately fake, non-regulated
   string with zero privacy risk; the brief explicitly permits it. Not blocking.
2. `.gitignore` change (trailing-slash removed so a `node_modules` symlink is also
   ignored) is correct and matches the plan AC; not separately exercised here but
   trivially correct.

## Rationale

All eight verifications pass with the expected exit codes. The gate is fail-closed
on unresolvable/empty ranges (F1 satisfied non-vacuously), fires on both the
employer-token and home-path classes, withholds matched content from logs, and is
GREEN on its own PR. Build and the full + targeted test suites are green. The
prompt-integrity test is strict. Scope is disjoint as specified. No privacy leak
in any committed file. PASS.
