import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentHome = tmpdir();

jest.mock("node:os", () => {
  const actual = jest.requireActual("node:os") as typeof import("node:os");
  return {
    ...actual,
    homedir: () => currentHome,
  };
});

import { getClient, resetClient } from "../src/llm/anthropicClient";

function writeOAuth(home: string, expiresAtMs: number) {
  const dotclaude = join(home, ".claude");
  mkdirSync(dotclaude, { recursive: true });
  writeFileSync(
    join(dotclaude, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "oauth-token-stub",
        expiresAt: expiresAtMs,
      },
    }),
  );
}

describe("anthropicClient.getClient", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    resetClient();
    delete process.env.ANTHROPIC_API_KEY;
    currentHome = mkdtempSync(join(tmpdir(), "monday-ac06-"));
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    resetClient();
  });

  test("returns a client when a valid OAuth token is present", () => {
    writeOAuth(currentHome, Date.now() + 60 * 60 * 1000);
    expect(getClient()).toBeDefined();
  });

  test("falls back to ANTHROPIC_API_KEY when OAuth is missing", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-stub";
    expect(getClient()).toBeDefined();
  });

  test("falls back to API key when OAuth is expired", () => {
    writeOAuth(currentHome, Date.now() - 60 * 1000);
    process.env.ANTHROPIC_API_KEY = "sk-test-stub";
    expect(getClient()).toBeDefined();
  });

  test("throws a clear error when both OAuth and API key are absent", () => {
    expect(() => getClient()).toThrow(
      /OAuth.*ANTHROPIC_API_KEY|ANTHROPIC_API_KEY.*OAuth/i,
    );
  });

  test("caches the client across calls until reset", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-stub";
    const a = getClient();
    const b = getClient();
    expect(a).toBe(b);
    resetClient();
    const c = getClient();
    expect(c).not.toBe(a);
  });
});
