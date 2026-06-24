# 1169 — monday-bot hardening: automatic privacy CI gate + .gitignore fix + Layer-B prompt-integrity test

## Execution model

**subagent (3-role).** Per the operator brief: real subagents for plan-review +
executor + execution-review; planner inline-skipped (specific reason below).
Rationale: the work spans 5 files across CI/config/test surfaces (above the
trivial-skip threshold), and the brief mandates the 3-role split — the orchestrator
coordinates and ships but does not write the code inline. Executor and both
reviewers are separate write-capable subagents.

## ELI5

monday-bot is a PUBLIC repo. Three small, unrelated safety guards in one PR:

1. **The headline — an automatic privacy guard in CI.** Right now nothing in the
   robot's automated checks looks for a secret company name sneaking into the
   public code. A leak slipped to master once because the only check was a manual
   one a human had to remember to run. We add a GitHub Actions job that runs on
   every pull request, looks at what the PR changed, and FAILS the check if a
   regulated employer token shows up. The secret token list NEVER lives in the
   public repo — it's read from a GitHub Actions **secret**, so the guard can look
   for the bad words without ever writing them down where the public can read them.

2. **A one-character `.gitignore` fix.** The line `node_modules/` (with a slash)
   does not hide the auto-created `node_modules` *symlink* (a slash means
   "directory only"). So a careless `git add -A` could stage it. Change it to
   slash-less `node_modules` so both a real folder and a symlink are ignored.

3. **A guard test for the answer-quality prompt.** The robot's system prompt has
   two rules that a past fix added: "if you found nothing relevant, say you
   couldn't find it" (abstain) and "lead with what you DID find." A future tidy-up
   could silently delete one and quietly regress quality. We add a tiny unit test
   that reads the prompt and fails if either rule disappears. To let the test read
   the prompt we just `export` it (no wording change).

## Why

- #1169: PUBLIC repo, no AUTOMATIC privacy check on PRs — only a manual gate.
  A token leak reached master on the #1066 rename because CI caught nothing.
- .gitignore: trailing-slash pattern misses the symlinked `node_modules`
  (reproduced: `git check-ignore node_modules` exits 1 today).
- #1170 mechanical half: lock the #1066 P3 abstention-bias fix so a prompt
  refactor cannot silently drop the abstain or lead-with-found clause.

## Scope / disjoint-file guarantee

Touches ONLY:
- `.github/workflows/privacy.yml` (new)
- `scripts/privacy-denylist-check.sh` (new)
- `.gitignore` (one-line edit)
- `src/llm/generate.ts` (add `export` keyword to `SYSTEM_PROMPT` only — NO wording change)
- `tests/generate.prompt-integrity.test.ts` (new)
- `.ai-workspace/plans/...` + `.ai-workspace/reviews/...` (force-added provenance, per repo convention)

Does NOT touch `src/knowledge/startup.ts`, `src/index.ts`, `src/slack/adapter.ts`
(the #1171 surface — already merged as PR #210, but kept disjoint regardless).

## Design notes

### Change 1 — privacy CI gate (reuse the sibling PUBLIC-repo pattern)
- Pattern source: a sibling PUBLIC repo runs a `pull_request`-triggered workflow
  that calls a `scripts/privacy-denylist-check.sh` bash script (concurrency-guarded,
  `permissions: contents: read`). We copy that shape.
- **Token home = GitHub Actions secret, NOT a committed file.** In gpe the inline
  tokens are PUBLIC project names; monday-bot's regulated tokens are the EMPLOYER
  brand, which would itself leak if committed to a public repo (even in a rule-spec
  file). So tokens live ONLY in the repo secret `PRIVACY_DENYLIST_TOKENS`
  (newline-separated regex fragments), injected into the script via env. The
  workflow YAML and the script contain ZERO tokens — satisfies "NEVER inline in
  workflow YAML or code," and is stronger than a committed rule-spec file (no token
  in ANY committed file at all).
- **Scope = the PR's added diff lines** (`git merge-base origin/<base> HEAD` →
  `git diff base...HEAD`, scan added lines). Catches a token a PR introduces — the
  #1066 scenario. `fetch-depth: 0` so merge-base resolves.
- **Always-on home-path guard** (no secret needed): added lines matching
  `(/Users/|/home/)<name>/` fail the check (cairn lesson: a fixed-token denylist is
  blind to the home-path leak class — gpe #955).
- **Fail-closed:** exit 1 on ANY hit. Matched content is WITHHELD from CI logs
  (printing it would re-leak the very token/username into public CI logs) — only a
  count + remediation message is printed.
- **Secret-unset behavior:** print a loud `::warning::` "set PRIVACY_DENYLIST_TOKENS
  to arm employer-token scanning" and continue (home-path guard still runs). The job
  is GREEN on a clean PR with the secret unset — so this PR passes CI without the
  operator having to hand me the token. Arming the secret is an operator deploy step
  (the brief: "I deploy to the live service"). Documented in the RESTORE/setup note.
- **Required-check:** the job runs on every PR and fails on hits. Marking it a
  *required status check* in branch protection is operator repo-config (noted).

### Change 2 — .gitignore
`node_modules/` → `node_modules`. AC: `git check-ignore node_modules` exits 0.

### Change 3 — Layer-B prompt-integrity test
- `export const SYSTEM_PROMPT` in `src/llm/generate.ts` (add keyword only).
- New `tests/generate.prompt-integrity.test.ts` imports `SYSTEM_PROMPT` and asserts
  it contains BOTH the abstain clause (`/no relevant information/i` AND
  `/couldn't find/i`) AND the lead-with-found clause (`/Lead with what you DID find/`).

## Binary AC (checkable from outside the diff)

1. `npm run build` exits 0 (tsc clean) in the worktree.
2. `npm test` exits 0 (all jest green, incl. the new prompt-integrity test).
3. `npm test -- generate.prompt-integrity` runs ≥1 test and passes.
4. `git -C <worktree> check-ignore node_modules` exits 0 (symlink now ignored).
5. Running the privacy script over a synthetic diff containing a FAKE token (via
   `PRIVACY_DENYLIST_TOKENS=FAKEBRANDXYZ`) exits 1; over a clean diff exits 0
   (fail-closed proof, no real token used).
6. `git grep -nE` over the committed diff for any regulated employer token finds
   NOTHING (privacy self-grep clean) — and no token in plan/review/commit surfaces.
7. The new `.github/workflows/privacy.yml` job passes (green) on this PR.
8. CI green on ubuntu-latest AND windows-latest.

## 3-role

- **planner**: inline-skip — the operator's brief fully specifies the outcome +
  binary AC for three small disjoint guards; this plan doc transcribes that contract.
  The planning is inseparable from the just-given operator instructions (no
  independent design space to hand to a fresh planner subagent).
- **plan-review**: real subagent (write-capable) → `.ai-workspace/reviews/1169-plan-review.md`.
- **executor**: real subagent (write-capable) implements in the worktree.
- **execution-review**: real subagent (write-capable) → `.ai-workspace/reviews/1169-execution-review.md`.

## Privacy

This PR is about privacy. No regulated employer host/brand/space-key/project-key
token in ANY committed file, plan, review artifact, branch name, or commit message.
Tokens referenced only as "the employer denylist tokens." Self-grep before push.

cairn: hit — "A privacy/denylist gate scoped to a fixed TOKEN set is blind to the
home-path class" (T1 2026-06-17) → home-path guard included. Also "PUBLIC repo:
scrub even META-mentions of the regulated employer tokens" → tokens kept in secret only.
