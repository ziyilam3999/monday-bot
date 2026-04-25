/**
 * Cache-miss spy test for `_resetExtractorForTests`. Mocks @xenova/transformers
 * to count pipeline-builder invocations; asserts cache hit on second call,
 * cache miss after reset. See PR #34 / issue #36 for the no-op-passes-too gap.
 *
 * Lives in a separate file so the real-model tests in tests/embed.test.ts
 * stay free of module mocks.
 */

let mockPipelineInvocations = 0;

jest.mock("@xenova/transformers", () => ({
  pipeline: jest.fn(async () => {
    mockPipelineInvocations += 1;
    // Return a stub extractor that yields a deterministic 4-d vector.
    return async (_text: string, _opts?: unknown) => ({
      data: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    });
  }),
}));

import { embed, _resetExtractorForTests } from "../src/embeddings/embed";

describe("embed cache lifecycle", () => {
  beforeEach(() => {
    mockPipelineInvocations = 0;
    _resetExtractorForTests();
    mockPipelineInvocations = 0;
  });

  it("first call invokes pipeline once; second call hits cache", async () => {
    expect(mockPipelineInvocations).toBe(0);
    await embed("warm");
    expect(mockPipelineInvocations).toBe(1);
    await embed("cached");
    expect(mockPipelineInvocations).toBe(1);
  });

  it("_resetExtractorForTests() forces a fresh pipeline build on next call", async () => {
    await embed("warm");
    expect(mockPipelineInvocations).toBe(1);
    _resetExtractorForTests();
    await embed("after-reset");
    expect(mockPipelineInvocations).toBe(2);
  });

  it("_resetExtractorForTests() throws when NODE_ENV is not test", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => _resetExtractorForTests()).toThrow(
        /must only be called from Jest tests/,
      );
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
