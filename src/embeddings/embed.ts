const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

export const EMBEDDING_MODEL = MODEL_ID;

let pipelinePromise: Promise<(text: string, opts?: unknown) => Promise<{ data: Float32Array | number[] }>> | null = null;

async function getExtractor() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import("@xenova/transformers");
      const extractor = (await pipeline("feature-extraction", MODEL_ID)) as unknown as (
        text: string,
        opts?: unknown,
      ) => Promise<{ data: Float32Array | number[] }>;
      return extractor;
    })();
  }
  return pipelinePromise;
}

export async function embed(text: string): Promise<number[]> {
  if (typeof text !== "string") {
    throw new TypeError("embed() requires a string input");
  }
  const input = text.length === 0 ? " " : text;
  const extractor = await getExtractor();
  const output = await extractor(input, { pooling: "mean", normalize: true });
  const raw = output.data;
  const vec: number[] = Array.isArray(raw) ? [...raw] : Array.from(raw);
  return vec;
}
