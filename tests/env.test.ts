import { MissingEnvVarError, parseDefaultProjects, validateEnv } from "../src/config/env";

describe("validateEnv", () => {
  // Test placeholders deliberately do NOT use the xoxb-/xapp-/xoxp- prefix:
  // the secrets-hygiene AC greps tracked files for that exact pattern.
  const BOT_TOKEN_PLACEHOLDER = "bot-token-test-value";
  const APP_TOKEN_PLACEHOLDER = "app-token-test-value";

  it("returns parsed env when all required vars are present", () => {
    const env = validateEnv({
      SLACK_BOT_TOKEN: BOT_TOKEN_PLACEHOLDER,
      SLACK_APP_TOKEN: APP_TOKEN_PLACEHOLDER,
    });
    expect(env.slackBotToken).toBe(BOT_TOKEN_PLACEHOLDER);
    expect(env.slackAppToken).toBe(APP_TOKEN_PLACEHOLDER);
  });

  it("throws MissingEnvVarError when SLACK_BOT_TOKEN is missing", () => {
    expect(() =>
      validateEnv({ SLACK_APP_TOKEN: APP_TOKEN_PLACEHOLDER })
    ).toThrow(MissingEnvVarError);
  });

  it("throws MissingEnvVarError when SLACK_APP_TOKEN is empty string", () => {
    expect(() =>
      validateEnv({ SLACK_BOT_TOKEN: BOT_TOKEN_PLACEHOLDER, SLACK_APP_TOKEN: "" })
    ).toThrow(MissingEnvVarError);
  });

  it("error message lists ALL missing variables", () => {
    try {
      validateEnv({});
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvVarError);
      const msg = (err as Error).message;
      expect(msg).toContain("SLACK_BOT_TOKEN");
      expect(msg).toContain("SLACK_APP_TOKEN");
      expect(msg.toLowerCase()).toContain("missing");
    }
  });

  it("throws MissingEnvVarError when a token is whitespace-only", () => {
    expect(() =>
      validateEnv({ SLACK_BOT_TOKEN: BOT_TOKEN_PLACEHOLDER, SLACK_APP_TOKEN: "   \t  " })
    ).toThrow(MissingEnvVarError);
  });

  it("trims leading/trailing whitespace from returned token values", () => {
    const env = validateEnv({
      SLACK_BOT_TOKEN: `  ${BOT_TOKEN_PLACEHOLDER}  `,
      SLACK_APP_TOKEN: `\t${APP_TOKEN_PLACEHOLDER}\n`,
    });
    expect(env.slackBotToken).toBe(BOT_TOKEN_PLACEHOLDER);
    expect(env.slackAppToken).toBe(APP_TOKEN_PLACEHOLDER);
  });
});

describe("parseDefaultProjects (#1363)", () => {
  // SYNTHETIC keys only (PUBLIC repo) — the real default is env-driven.
  it("AC5 — comma-splits, trims, and drops empties", () => {
    expect(parseDefaultProjects("ABC, DEF ")).toEqual(["ABC", "DEF"]);
    expect(parseDefaultProjects("ABC,,  ,DEF,")).toEqual(["ABC", "DEF"]);
  });

  it("returns an empty list for undefined / empty / whitespace-only", () => {
    expect(parseDefaultProjects(undefined)).toEqual([]);
    expect(parseDefaultProjects("")).toEqual([]);
    expect(parseDefaultProjects("   ,  ")).toEqual([]);
  });

  it("does NOT uppercase — the JQL builder owns case/sanitisation (no redundant work)", () => {
    expect(parseDefaultProjects("abc, def")).toEqual(["abc", "def"]);
  });
});
