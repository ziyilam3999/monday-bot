/**
 * Single source of truth for the default Anthropic model id + rate card (#3136).
 *
 * Every call site — `src/llm/generate.ts`, `src/jira/nlFilterMapper.ts` and the
 * three `scripts/*.js` operators (which require this from `dist/`) — resolves
 * its model through here; no literal model id lives anywhere else in `src/` or
 * `scripts/`. The `ANTHROPIC_MODEL` env override contract (#18/#51) is
 * unchanged: env wins, else the default below.
 */

/** Default model: Claude Haiku 5.5 (1M context, standard rate card). */
export const DEFAULT_MODEL = "claude-haiku-5-5";

/** Resolve the REQUESTED model id: `ANTHROPIC_MODEL` override, else the default. */
export function resolveModel(): string {
  return process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
}

/**
 * Standard-rate card, Claude Haiku 5.5, prompts up to 100K tokens (every
 * monday-bot prompt is far below that — the eval budgets ~2K input tokens per
 * defect): $0.10/MTok input, $0.50/MTok output, no-cache upper bound.
 * Source: platform.claude.com/docs/en/about-claude/pricing, fetched 2026-10-15.
 */
export const PRICING = { inputPerMTok: 0.1, outputPerMTok: 0.5 };

/**
 * Legacy Haiku 4.5 card ($1/$5 per MTok, same source's legacy table) — kept
 * ONLY so `ANTHROPIC_MODEL` override / A-B arms price their runs on the card
 * of the model they actually requested.
 */
const LEGACY_PRICING = { inputPerMTok: 1.0, outputPerMTok: 5.0 };

/** Rate card for a REQUESTED model id: the 5.5 card, or legacy for a 4.x override. */
export function pricingForModel(modelId: string): {
  inputPerMTok: number;
  outputPerMTok: number;
} {
  return modelId.startsWith("claude-haiku-4") ? LEGACY_PRICING : PRICING;
}
