# 1169 — Plan Review: privacy CI gate + .gitignore fix + Layer-B prompt-integrity test

Decision: PASS

Reviewer: stateless plan-review subagent (3-role). Plan reviewed in full:
`.ai-workspace/plans/2026-06-23-1169-privacy-ci-gate-hardening.md`.

Verdict in one line: the design is sound, well-scoped, and privacy-conscious; the
headline risks (token never committed, matched content withheld from logs,
always-on home-path guard, fail-closed on hits) are all handled correctly. PASS,
with one elevated execution-hardening requirement and several non-blocking notes.

cairn: hit — "A privacy/denylist gate scoped to a fixed TOKEN set is blind to the
home-path class" (T1 2026-06-17) → plan already includes the always-on home-path
guard. Also hit — "Drop `set -e` in shell gates that must fail closed; guard each
command" (T2) → relevant to the vacuous-pass finding below. Also hit — "A repo-wide
privacy denylist CI scans ALL tracked files; a stale planning doc co[mmitted]..."
(the gpe self-exclude failure mode) → this plan SIDESTEPS that class by keeping
tokens in a secret (never committed), so no self-exclude / stale-doc risk exists.

---

## Findings

### ELEVATED — must be addressed in execution + verified by execution-review (not a plan redesign)

**F1. Guard against a silently-vacuous pass on a broken/empty diff range.**
The gate's entire value is catching a NEW token in a PR diff. Both the token scan
AND the home-path guard are diff-scoped (added lines only). If the diff range
resolves empty for the WRONG reason — `origin/<base>` ref unresolved, `merge-base`
returns nothing, a checkout quirk — the gate passes vacuously (grep over nothing →
exit 0) and looks GREEN. AC #7 ("job green on this PR") cannot distinguish a real
pass from a vacuous one; that is the single most important property of a privacy
gate and the current ACs do not prove it.
The design direction is correct (`fetch-depth: 0` so `merge-base` resolves; the
three-dot `base...HEAD` diff is the right "what this PR added" scope; on a
`pull_request` merge-commit checkout it still resolves to the PR's added lines).
What's missing is fail-closed rigor on the unhappy path:
- The script must `exit` non-zero if `git merge-base` / the diff range cannot be
  computed (treat an unresolvable base as a FAILURE, not "no hits"). Do not let
  `set -e`/silent-empty swallow it — guard each command explicitly (cairn lesson).
- The CI step should log the scanned added-line COUNT so the log visibly shows the
  range was non-empty (a 0-line scan on a code-bearing PR is itself a red flag).
- Recommend adding a Binary AC: "running the script with a deliberately
  unresolvable base exits non-zero" (checkable from outside the diff, no real token).

This is flagged as execution-hardening, not a FAIL, because the plan's stated
intent already points the right way and the executor + execution-review can close
it; but execution-review MUST confirm non-vacuous behavior before ship.

### Non-blocking

**N1. AC that the workflow actually TRIGGERS as a visible check is missing.**
A non-triggering or malformed workflow is silently ABSENT, not red. AC #7 says
"green," but the stronger property is "the privacy job appears in the PR's checks
and concludes success." Recommend an explicit AC (or a YAML-validity check, e.g.
`actionlint`/parse) so a workflow that never runs can't pass by absence. Marking it
a required status check in branch protection (operator repo-config) is correctly
noted as out-of-band.

**N2. Consider gpe-parity repo-wide scan on `push: branches: [master]`.**
The sibling runs on both `pull_request` AND push-to-master (full-file). This plan
is `pull_request` diff-scope only, which is correct for the stated #1066 "catch a
token a PR introduces" purpose, but won't catch a PRE-EXISTING leak already on
master. Given Rule G1 (always-PR) the PR gate covers the normal path; a cheap
push-to-master full-file backstop would add defense-in-depth. Enhancement, not
required.

**N3. AC #8 OS-scope is ambiguous.** "CI green on ubuntu AND windows" describes the
existing matrix `ci.yml` (build/test). The new bash privacy gate runs ubuntu-only
(like gpe); the plan should state that explicitly so AC #8 isn't read as "the bash
gate must pass on windows."

**N4. Secret-unset + fork-PR limitation — acceptable, worth a one-line note.**
GitHub does not expose secrets to fork PRs, so on a fork PR the employer-token scan
is unarmed (warn+pass); the home-path guard still runs. For a single-operator
public repo where the leak risk is the operator's own same-repo branch PRs (secrets
available), this is the right trade-off. Note it in the setup doc so it's a known
property, not a surprise.

---

## What the plan gets RIGHT (verified)

- **Token never committed.** Tokens live ONLY in the `PRIVACY_DENYLIST_TOKENS`
  GitHub Actions secret, injected via env. Workflow YAML and script carry ZERO
  tokens. This is strictly stronger than gpe's committed rule-spec list and removes
  the self-exclude / stale-planning-doc failure class entirely. Confirmed sound.
- **Matched content withheld from logs.** Only a count + remediation printed;
  token/username never re-leaked into public CI logs. Covers home-path matches too
  (printing the matched LINE would leak the username — plan withholds it; printing
  the diff's file PATH is safe).
- **Home-path guard always-on.** `(/Users/|/home/)<name>/` over added lines,
  no secret required — directly applies the cairn lesson; closes the #1066-class
  home-path blind spot of a fixed-token denylist.
- **Secret-unset warn+pass is defensible.** Lets THIS PR pass its own CI without the
  operator handing over the token; arming is an operator deploy step. Home-path
  guard still fires. Reasonable.
- **Prompt test — minimal + appropriately strict.** `export` on an existing const is
  the minimal change (and `NO_CONTEXT_ANSWER` is already exported beside it, so the
  pattern exists; no wording change). Asserting on `SYSTEM_PROMPT` specifically
  avoids accidental matches against `NO_CONTEXT_ANSWER`. Verified the live text
  contains both "no relevant information"/"couldn't find" (abstain) and "Lead with
  what you DID find" — the regexes match. Substring strictness on a deliberate
  load-bearing clause is DESIRABLE for a guard test: a reword should be a conscious
  decision that re-trips the test, exactly the intended behavior.
- **Scope/disjointness confirmed.** Touches `.github/workflows/privacy.yml` (new,
  separate from `ci.yml` — no matrix collision), `scripts/privacy-denylist-check.sh`
  (new), `.gitignore` (one line), `src/llm/generate.ts` (add `export` only),
  `tests/generate.prompt-integrity.test.ts` (new). Does NOT touch
  `src/knowledge/startup.ts`, `src/index.ts`, `src/slack/adapter.ts`. Verified.
- **AC #5 (fake-token fail-closed) is sound** — proves the MATCHER fails closed via
  a synthetic `FAKEBRANDXYZ` token, no real token used. (Note: it proves the matcher,
  not the CI diff-range — see F1.)
- **.gitignore fix correct.** `node_modules/` → `node_modules` makes
  `git check-ignore node_modules` exit 0 for both a dir and the auto-symlink. AC #4
  checkable from outside the diff.

## Rationale

The plan correctly solves the actual problem and avoids the gpe gate's known
failure modes. The one property a privacy gate must never lack — non-vacuous,
fail-closed scanning — is directionally present but not yet PROVEN by the ACs (F1);
that is an execution-hardening gap the downstream roles can and must close, not a
plan-level design error warranting a FAIL. No regulated employer token appears in
this artifact (referenced only as "the employer denylist tokens").
