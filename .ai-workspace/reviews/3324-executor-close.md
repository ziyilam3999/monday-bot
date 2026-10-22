# 3324 executor close — Slack entities un-escaped at the Slack→Telegram boundary

DISPATCH-NONCE:OR-NONCE-e528b0eb32e55f48

Plan: `.ai-workspace/plans/2026-10-22-3324-amp.md` (plan-review PASS, `.ai-workspace/reviews/3324-plan-review.md`) · branch 3324-amp · 2026-10-22

## Change

`src/telegram/formatter.ts` (one code file, per B1): added `decodeSlackEntities` — a plain
global replace of exactly `&lt;` → `<`, `&gt;` → `>`, `&amp;` → `&` (ampersand last,
mirroring `sanitizeTitle`'s encode order), applied ONCE per context-element text inside
`renderTelegramReply`, after `stripMrkdwn`. Nothing else changes: no adapter, transport, or
Slack-side edit; the body (`payload.text`) is not decoded (B3); the decode is a plain global
replace over the full element string with no corpus-specific casing (plan-review named-risk 2
discharged). Tests: 7 new arms appended to the `telegram/formatter` describe in
`tests/telegram.test.ts`, all driving the real seam `formatAnswer` (src/slack/formatter.ts)
→ `renderTelegramReply`; only synthetic titles and DEMO project keys appear.

## AC table

| AC | Evidence | Verdict |
|---|---|---|
| AC-1 field report | `npx jest tests/telegram.test.ts` at head: `AC-1 — field report` ✓ — line renders `… — General Dispute Resolution & Customer Support`; reply contains no `&amp;`/`&lt;`/`&gt;` | PASS |
| AC-2 `<`/`>` restored | `AC-2` ✓ — heading `Refund policy: "fast" <v2> track` byte-identical in the reply | PASS |
| AC-3 class coverage at real seam | `AC-3` ✓ — source `confluence:DEMO-3 & <extras>` AND heading `A < b & c > d` both render plain | PASS |
| AC-4 round-trip identity | `AC-4` ✓ — corpus `Intro`, `A & B`, `a<b&c>d` each rendered byte-identically; literal-entity titles in `AC-5` (`Costs &amp; Billing`, `Fees &lt; Guide`) round-trip byte-identically (amp-last decode order discriminated) | PASS |
| AC-5 exactly once, encoded set only | `AC-5` ✓ — `Costs &amp; Billing` renders `Costs &amp; Billing` (no double decode); `&quot;`/`&#39;` pass through untouched | PASS |
| AC-6 Telegram format safe | `AC-6` ✓ — markup title yields no `*`; `Sources:` + one-line-per-citation unchanged; `splitMessage` concat identity over a decoded long reply | PASS |
| AC-7 Slack untouched | `AC-7` ✓ (passes on BOTH master and head) — context elements byte-golden (`&amp;`/`&lt;`/`&gt;`), body literal entity stays, `formatAskDefectsBlocks` output unchanged and dropped by the renderer | PASS |
| AC-8 RED→GREEN, suite health | see below — 6 new arms FAIL on pristine origin/master, all 7 PASS at head | PASS |

## RED/GREEN evidence

- **RED (pristine origin/master):** `tmp/red-3324/` = `git archive origin/master` extract +
  repo `node_modules` symlink, with branch-head `tests/telegram.test.ts` copied in.
  `npx jest tests/telegram.test.ts` → **6 failed, 38 passed**: AC-1, AC-2, AC-3, AC-4, AC-5,
  AC-6 all fail (entities visible in rendered replies); AC-7 passes on master (Slack side
  unchanged — expected). `npm test` on the same copy shows the same single pre-existing
  failure as head (see below).
- **GREEN (branch head, worktree):** `npx jest tests/telegram.test.ts` → **44 passed, 0
  failed**.

## Test and build results (run by executor, at head)

- `npm test` → **776 passed, 1 failed** of 777; 68/69 suites pass. The one failure is
  `tests/generate.test.ts` ("sends no sampling parameter and the resolved default model"):
  expects default model `claude-haiku-5-5`, this environment resolves `glm-5.3`. Verified
  **pre-existing on pristine origin/master** (same failure in tmp/red-3324: 1 failed of 39 in
  tests/generate.test.ts) — unrelated to this change; no telegram/slack/formatter test fails.
- `npm run build` → **green** (`tsc` + build-stamp written, sha e9ac34c). `tsc` type-checks
  `src/`; the test files are compiled by ts-jest during `npm test`. (`npm run typecheck` was
  not run — dispatch restricted runs to `npm test` and `npm run build`.)

Executor-close: draft PR opened from 3324-amp (Slack→Telegram citation-title un-escape in src/telegram/formatter.ts + 7 fixture arms, RED/GREEN recorded above); close note committed on the branch.
