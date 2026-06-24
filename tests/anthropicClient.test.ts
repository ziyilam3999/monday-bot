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

const mockExecFileSync = jest.fn();

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process") as typeof import("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
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
    // F6 mirror — default: Keychain probe throws (matches non-darwin / missing entry).
    // Tests that exercise the Keychain fallback override per-case via mockImplementationOnce.
    mockExecFileSync.mockReset();
    mockExecFileSync.mockImplementation(() => {
      throw new Error("security: SecKeychainSearchCopyNext: The specified item could not be found");
    });
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

// ── F6 mirror — macOS Keychain fallback in readOAuthToken() ────────────────
//
// On darwin, Claude Code stores OAuth in Keychain rather than on disk. When
// the file read fails AND we are on darwin, anthropicClient shells out to
// /usr/bin/security to fetch the blob (same JSON shape). Mirrors forge-harness
// anthropic.ts v0.40.5.
//
// Test isolation: per-test Object.defineProperty(process, "platform", ...)
// with afterEach restore. process.platform is read-only on Node 20+, so
// configurable: true is required for the setter to succeed.

describe("F6 — readOAuthToken() falls back to macOS Keychain on darwin", () => {
  const ORIGINAL_PLATFORM = process.platform;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  beforeEach(() => {
    resetClient();
    delete process.env.ANTHROPIC_API_KEY;
    // Fresh tmp home that does NOT contain ~/.claude/.credentials.json so the
    // file read fails and the Keychain fallback path triggers.
    currentHome = mkdtempSync(join(tmpdir(), "monday-f6-"));
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    resetClient();
  });

  function keychainBlob(accessToken: string, expiresAt: number): string {
    return JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });
  }

  test("(i) darwin + Keychain returns valid JSON blob → getClient() builds a client", () => {
    setPlatform("darwin");
    mockExecFileSync.mockImplementationOnce(() =>
      keychainBlob("oauth-from-keychain", Date.now() + 60 * 60 * 1000),
    );
    expect(getClient()).toBeDefined();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const callArgs = mockExecFileSync.mock.calls[0];
    expect(callArgs[0]).toBe("/usr/bin/security");
    expect(callArgs[1]).toEqual(
      expect.arrayContaining(["find-generic-password", "-s", "Claude Code-credentials", "-w"]),
    );
  });

  test("(ii) darwin + Keychain execFileSync throws → falls through to API key", () => {
    setPlatform("darwin");
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("security: SecKeychainSearchCopyNext: not found");
    });
    process.env.ANTHROPIC_API_KEY = "sk-test-stub";
    expect(getClient()).toBeDefined();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  test("(iii) non-darwin + missing file → Keychain shell-out is never called", () => {
    setPlatform("linux");
    process.env.ANTHROPIC_API_KEY = "sk-test-stub";
    expect(getClient()).toBeDefined();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  test("(iv) darwin + Keychain returns malformed JSON → null sentinel, no crash", () => {
    setPlatform("darwin");
    mockExecFileSync.mockImplementationOnce(() => "this-is-not-json");
    process.env.ANTHROPIC_API_KEY = "sk-test-stub";
    expect(getClient()).toBeDefined();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });
});
