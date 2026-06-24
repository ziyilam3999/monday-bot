# 1066 Citation/Answer Hygiene (slice 1) — Execution Review

Decision: PASS

Stateless execution review of the worktree diff for monday-bot #1066 slice 1
(citation/answer hygiene). Reviewer did not write this code; verified by reading
the diff and running the gates independently.

## Gates (run by reviewer)
- `npm run build` → exit 0 (tsc clean).
- `npm test` → exit 0. **22 suites passed, 183 tests passed**, 0 failed.

## Privacy
Ran `git --no-pager diff | grep -i <regulated tokens>` plus a token-scan of every
changed surface. **No regulated employer-brand token appears anywhere in the
diff.** Repo-public-safe. PASS.

## Scope guard
`git diff --name-only` = exactly the 5 expected files
(`src/llm/generate.ts`, `src/slack/formatter.ts`, `tests/generate.test.ts`,
`tests/slack-formatter.test.ts`, `tests/integration.e2e.test.ts`).
`src/slack/adapter.ts` and `src/slack/commands.ts` are NOT in the diff. PASS.

## Fix-by-fix verification (read code, not claims)
- **Fix 1 — `selectCitedCitations`**: parses distinct `[N]` markers via
  `matchAll(/\[(\d+)\]/g)` into a `Set` (dedupe), returns `citations.filter`
  keeping original list numbers/order, returns `[]` when `cited.size === 0`
  (refusals / NO_CONTEXT_ANSWER), defensive guard `typeof answer !== "string"
  || !Array.isArray(citations) -> []`. Applied at BOTH the live-LLM return
  (generate.ts:170) AND `offlineAnswer` (generate.ts:69). Empty-chunks
  short-circuit (:118) and non-text branch (:165) still return `citations: []`,
  untouched. Exported and unit-tested. CORRECT.
- **Fix 2 — SYSTEM_PROMPT reorder**: now leads "Lead with what you DID find …
  cite it with inline [N] … only after stating what you found, note any
  remaining gap." KEEPS the honesty rule ("If the context contains no relevant
  information, say you couldn't find the information"), the never-cite-outside
  rule ("Never cite outside the numbered list"), and the concise-Slack guidance.
  Prompt-string only; no logic change. No test asserts the prompt string. CORRECT.
- **Fix 3 — `sanitizeTitle`**: escapes `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;` in
  that order (ampersand first, so `<`/`>` replacements aren't double-escaped),
  then strips `[*~`]`. Leaves `_` intact. Applied to BOTH `c.source` and
  `c.heading`. The `*[${n}]*` bold wrapper is built OUTSIDE the sanitize call,
  so the wrapper asterisks survive. CORRECT.
- **Tests**: `selectCitedCitations` suite covers `[2]/[4] -> 2,4`, no-markers
  `-> []`, `NO_CONTEXT_ANSWER -> []`, plus dedupe and out-of-range and the
  defensive cases. Formatter test asserts no literal `**` and no backtick
  survive while visible words ("Important"/"Guide"/"code") remain. The updated
  2-chunk live-path test now asserts cited-only (length 1, citation number 1)
  and drops the stale 2nd-citation assertion. CORRECT.

## e2e-weakening judgment (the item to scrutinize) — FAITHFUL, not a weakening
The executor changed the two AC-03 parity assertions in
`tests/integration.e2e.test.ts`. The original tests proved "format parity /
parser-agnostic survival" by asserting the citation set contained EVERY source
format (`expect(sources).toEqual(expect.arrayContaining([...all formats...]))`).
That proof vehicle is exactly what slice-1 deliberately removes: under cited-only
filtering the offline answer cites only `[1]`, so only the top-ranked source
survives in the citation set. Keeping the old assertion would assert the OLD
"all-sources-cited" contract that this slice is built to retire — it could not
pass and would be self-contradictory.

The re-expression relocates the SAME intent to the index layer:
`expect(svc.getStatus().documentCount).toBe(2)` (and `.toBe(4)`) directly proves
all N formats survived indexing — which IS the parser-agnostic property (a
silently-dropped format would lower the unique-source count). It additionally
KEEPS a meaningful citation invariant: every rendered source must be one of the
declared parity formats (`for (const s of sources) expect([...]).toContain(s)`),
so no foreign source can leak. Only the now-impossible `sources.length >= 2`
assertion is relaxed to `>= 1`.

Net: the change ADDS a more direct index-layer proof of parser-agnostic survival
plus a no-foreign-source membership check, and only relaxes the one assertion the
new contract makes mechanically impossible. This is a faithful, minimal
preservation of original intent, NOT an improper weakening. The 183-green run
confirms `getStatus().documentCount` is real (the new assertions are non-vacuous).

## cairn
`node skills/cairn/bin/cairn-find.mjs "test weaken"` / `"assertion contract"` —
relevant hit: T1 (2026-05-27) "When testing a generated prompt or assembled
string, assert on the runtime-captured output, not a source-grep of the
generator." Applies to Fix 2: the prompt reorder is correctly verified via
runtime behavior (no test asserts the prompt string), and the citation behavior
is asserted on runtime output (selectCitedCitations results), not source greps.
Consistent with this diff.

## Findings
None. No required changes.
