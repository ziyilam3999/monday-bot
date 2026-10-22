# 3324 plan-review (round 1) — source titles show HTML entities on Telegram

Plan: `.ai-workspace/plans/2026-10-22-3324-amp.md` · branch 3324-amp · 2026-10-22

## Review

DISPATCH-NONCE:OR-NONCE-b5b10bdae6e72dda

Decision: PASS

Premises verified by execution, not just by reading:

- **Chain reproduced.** Ran the plan's own fixture repro (`tmp/repro-3324.cjs`, compiled pure formatters, no network): `formatAnswer` emits `*[1]* confluence:DEMO-1 — General Dispute Resolution &amp; Customer Support`; `renderTelegramReply` passes it through as `…&amp;…`, and transport sends plain text with no parse_mode (`src/telegram/transport.ts:82`, `src/telegram/formatter.ts:20`). Exactly the field report, so the RED premise of AC-8 is real on origin/master (branch head differs from master only by the plan file — verified via `git diff --stat origin/master..HEAD`).
- **Boundary is the right one and covers the class.** `formatAnswer` (`src/slack/formatter.ts:203`) is the ONLY producer of `context` blocks in `src/`, and `renderTelegramReply` is the only Telegram render of citation lines (adapter `src/telegram/adapter.ts:196`; the other `sendMessage` path is the static help card, which carries no citation titles). Defects blocks are `section` blocks and are dropped by `renderTelegramReply`'s `block.type !== "context"` guard, so no citation-title path bypasses the boundary. Decoding context-element texts as a class (B3) is therefore genuinely exhaustive, not enumerated.
- **Decode set/arity/order are correct and AC-discriminating.** `sanitizeTitle` (`src/slack/formatter.ts:73`) encodes `& < >` (& first) and strips `* ~ ` backtick. The planned inverse (`&lt;`, `&gt;`, then `&amp;` last, once) is the correct inverse. I checked the order-sensitivity concretely: a source title literally `&lt;` sanitizes to `&amp;lt;`; the amp-last decode returns `&lt;` (byte-identical, AC-4 passes) while an amp-FIRST decode would return `<` — so AC-4's literal-entity corpus arm genuinely discriminates decode order, not just decode presence. Double-escape arm (`Costs &amp; Billing` → `&amp;amp;` → one decode → `&amp;`) is arithmetically sound.
- **AC structure.** Both test-table rows have ≥3 must-fire and ≥3 must-not-fire arms; must-not-fire covers already-plain title, literal-entity title, non-set sequences, Slack golden bytes, body text, defects blocks. All arms observable outside the diff via the real seams (`formatAnswer` → `renderTelegramReply`).
- **Size S confirmed.** Production change is one file (`src/telegram/formatter.ts`), tests extend the existing `tests/telegram.test.ts`, no adapter/transport/Slack edit, no smoke.

Findings (none blocking):

1. **MINOR (prose overclaim, not load-bearing).** B2 states "render(sanitize(s)) ≡ s for every string s" — false for strings containing `*`, `~`, or backtick, which `sanitizeTitle` strips irreversibly (`a*b` → `ab`). The ACs (AC-4 corpus, AC-6 no-`*` arm) correctly scope identity to the escaped set only, so this is wording, not an AC defect. Executor should not "fix" the strip to chase the prose claim.
2. **NAMED-RISK NOTE (carry to execution-review, per #2416 round-scope).** A decode implemented as three literal regex replacements can be memorized by a stub tuned to the AC corpus (e.g. handling only `&amp;`/`&lt;`/`&gt;` as standalone tokens). Execution-review should read the actual decode in `src/telegram/formatter.ts` and confirm it is a plain global replace over the full context-element string, applied at the boundary for every element, with no corpus-specific casing.
3. **NAMED-RISK NOTE (already named by the plan, affirm it).** B4's future-parse_mode risk and B5's pre-escaped-upstream-title risk are correctly descoped with execution-review conditions; B5's byte-identity contract makes the descope decidable later. No AC arm should be added for either (enumerated defense = next attack surface).
