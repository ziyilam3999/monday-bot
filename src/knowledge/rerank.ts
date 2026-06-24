/**
 * Lever 2 — rerank a wider candidate pool with a local cross-encoder (#1191).
 *
 * Safety net for both failure modes: re-score a larger batch of bi-encoder
 * candidates with a cross-encoder that reads (question, passage) JOINTLY, then
 * sort by that score. Default OFF (measure-first / Rule 18) — wired + measurable,
 * flipped ON only after a real-corpus run shows it helps over expansion+cap.
 *
 * Correction #4 (plan-review): `Xenova/ms-marco-MiniLM-L-6-v2` is a
 * sequence-CLASSIFICATION reranker, NOT feature-extraction. Verified against
 * transformers.js 2.17.2: the high-level `pipeline('text-classification')` does
 * NOT forward a sentence PAIR to its tokenizer, so the cross-encoder is driven
 * the low-level way — `AutoTokenizer` + `AutoModelForSequenceClassification`,
 * tokenizing the (question, passage) pair together via the tokenizer's
 * `text_pair` option and reading the single relevance logit from the model
 * output. Only the LAZY-LOAD mechanism is mirrored from embed.ts.
 *
 * The cross-encoder scores the ORIGINAL question (not the expanded query) — the
 * expansion only widens the bi-encoder's recall net; the cross-encoder judges
 * true relevance to what the user actually asked.
 *
 * An injectable `scoreFn` lets unit tests run deterministically with a fake
 * scorer (NO real model), and bypasses jest's package-level `@xenova` stub
 * (which only fakes feature-extraction). The real-model path is exercised only
 * outside jest (eval:recall with rerank ON) and may require a model download.
 */

/** Minimal shape rerank needs: a `text` to score. */
export interface RerankCandidate {
  text: string;
}

/**
 * Score a (question, passage) pair. Higher = more relevant. May be sync or
 * async. Injected in tests; defaults to the real cross-encoder.
 */
export type ScoreFn = (question: string, text: string) => number | Promise<number>;

export interface RerankConfig {
  /** Default false. When false, rerank is an identity (returns candidates as-is). */
  enabled?: boolean;
  /** How many top bi-encoder candidates to feed the cross-encoder. Default 150. */
  candidatePool?: number;
  /** Inject a deterministic scorer (tests). Defaults to the real cross-encoder. */
  scoreFn?: ScoreFn;
}

const CROSS_ENCODER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

interface CrossEncoder {
  tokenizer: (
    text: string,
    opts: { text_pair: string; padding: boolean; truncation: boolean },
  ) => unknown;
  model: (inputs: unknown) => Promise<{ logits: { data: ArrayLike<number> } }>;
}

// Lazy cross-encoder loader — mirrors embed.ts's lazy promise MECHANISM (not its
// task). Loads tokenizer + sequence-classification model so the (question,
// passage) PAIR can be tokenized together (the high-level text-classification
// pipeline drops text_pair in transformers.js 2.17.2).
let encoderPromise: Promise<CrossEncoder> | null = null;

async function getEncoder(): Promise<CrossEncoder> {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import(
        "@xenova/transformers"
      );
      const tokenizer = await AutoTokenizer.from_pretrained(CROSS_ENCODER_MODEL);
      const model = await AutoModelForSequenceClassification.from_pretrained(
        CROSS_ENCODER_MODEL,
      );
      return {
        tokenizer: (text, opts) => (tokenizer as unknown as (...a: unknown[]) => unknown)(text, opts),
        model: (inputs) =>
          (model as unknown as (i: unknown) => Promise<{ logits: { data: ArrayLike<number> } }>)(
            inputs,
          ),
      };
    })();
  }
  return encoderPromise;
}

/** For tests only — drop the cached real-model promise. */
export function _resetRankerForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "_resetRankerForTests() must only be called from Jest tests; production code should not import it.",
    );
  }
  encoderPromise = null;
}

/**
 * Default cross-encoder scorer. Tokenizes the (question, passage) pair together
 * and returns the model's single relevance logit (higher = more relevant). ms-marco
 * cross-encoders emit one regression logit per pair.
 *
 * The injected scoreFn is the deterministic unit-tested path; this default is the
 * production wiring. It is exercised end-to-end by `eval:recall` with rerank ON.
 */
async function defaultScore(question: string, text: string): Promise<number> {
  const enc = await getEncoder();
  const inputs = enc.tokenizer(question, {
    text_pair: text,
    padding: true,
    truncation: true,
  });
  const { logits } = await enc.model(inputs);
  return typeof logits?.data?.[0] === "number" ? logits.data[0] : 0;
}

/**
 * Re-score `candidates` against the ORIGINAL question with the cross-encoder
 * (or an injected scorer) and return them sorted by descending score. Returns
 * the input unchanged when disabled or empty. Stable for equal scores (original
 * relative order preserved).
 */
export async function rerank<T extends RerankCandidate>(
  question: string,
  candidates: T[],
  cfg?: RerankConfig,
): Promise<T[]> {
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates;
  const enabled = cfg?.enabled ?? false;
  if (!enabled) return candidates;

  const scoreFn = cfg?.scoreFn ?? defaultScore;

  const scored = await Promise.all(
    candidates.map(async (c, idx) => ({
      c,
      idx,
      score: await scoreFn(question, c.text),
    })),
  );

  // Sort by score desc; stable on ties via original index.
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return scored.map((s) => s.c);
}
