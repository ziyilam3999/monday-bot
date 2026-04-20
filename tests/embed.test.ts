import { embed } from "../src/embeddings/embed";

jest.setTimeout(120_000);

describe("embed", () => {
  it("returns a numeric array with length >= 64 and non-zero values", async () => {
    const vec = await embed("What is the VPN setup procedure?");
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.length).toBeGreaterThanOrEqual(64);
    expect(vec.some((v) => v !== 0)).toBe(true);
    expect(vec.every((v) => typeof v === "number" && Number.isFinite(v))).toBe(true);
  });

  it("produces consistent dimensionality across different inputs", async () => {
    const a = await embed("short");
    const b = await embed(
      "A much longer sentence with several words that should still produce the same vector length.",
    );
    expect(a.length).toBe(b.length);
  });

  it("produces similar vectors for similar meanings", async () => {
    const a = await embed("how to reset my password");
    const b = await embed("I forgot my password, what should I do");
    const c = await embed("pasta recipe with tomatoes");
    const cos = (x: number[], y: number[]) => {
      let dot = 0;
      let nx = 0;
      let ny = 0;
      for (let i = 0; i < x.length; i++) {
        dot += x[i] * y[i];
        nx += x[i] * x[i];
        ny += y[i] * y[i];
      }
      return dot / (Math.sqrt(nx) * Math.sqrt(ny));
    };
    const close = cos(a, b);
    const far = cos(a, c);
    expect(close).toBeGreaterThan(far);
  });

  it("does not throw on empty string input", async () => {
    const vec = await embed("");
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.length).toBeGreaterThan(0);
  });
});
