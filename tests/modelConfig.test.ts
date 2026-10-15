/**
 * #3136 fix 2 - `resolveModel` env-override contract. The scripts fell back
 * with `||` before the modelConfig consolidation; `??` handed the API an
 * EMPTY string when `ANTHROPIC_MODEL=""`. Empty must mean "unset".
 */
import { DEFAULT_MODEL, resolveModel, pricingForModel } from "../src/llm/modelConfig";

const LEGACY_ID = "claude-haiku-4-5-20251001";

describe("resolveModel (#3136 fix 2: empty-string fallback)", () => {
  const original = process.env.ANTHROPIC_MODEL;

  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = original;
  });

  test("MUST-FIRE: ANTHROPIC_MODEL set to an empty string -> default id", () => {
    process.env.ANTHROPIC_MODEL = "";
    expect(resolveModel()).toBe(DEFAULT_MODEL);
  });

  test("unset ANTHROPIC_MODEL -> default id", () => {
    delete process.env.ANTHROPIC_MODEL;
    expect(resolveModel()).toBe(DEFAULT_MODEL);
  });

  test("MUST-NOT-FIRE: a set value (4.5 id) still overrides", () => {
    process.env.ANTHROPIC_MODEL = LEGACY_ID;
    expect(resolveModel()).toBe(LEGACY_ID);
  });

  test("default id is Haiku 5.5 and the 4.x override prices on the legacy card", () => {
    delete process.env.ANTHROPIC_MODEL;
    expect(DEFAULT_MODEL).toBe("claude-haiku-5-5");
    expect(resolveModel()).toBe("claude-haiku-5-5");
    expect(pricingForModel(LEGACY_ID)).toEqual({ inputPerMTok: 1.0, outputPerMTok: 5.0 });
    expect(pricingForModel(DEFAULT_MODEL)).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
  });
});
