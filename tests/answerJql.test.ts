/**
 * Unit tests for the `buildAnswerJql` factory (#1346) — pure wiring of the
 * NL→JQL viewing layer into the Slack `adminService`. ZERO network: the search
 * seam is injected, and `MONDAY_TEST_MODE=1` makes the LLM mapper deterministic.
 *
 * NOTE ON SYNTHETIC HOSTS: these tests deliberately use `https://demo.example.com`
 * — NOT the repo-conventional Atlassian sandbox host (the `atlassian`-branded
 * `dot-net` form used by the other jira tests) — because the #1346 AC9 privacy
 * grep matches that bare host token, so committing such a fixture would trip the
 * privacy gate. Do NOT "fix" this back to the Atlassian-host form. See the plan's
 * privacy gate + plan-review MUST-fix #2.
 */
import { buildAnswerJql } from "../src/jira/answerJql";
import { JiraIssue, JqlSearchFetcher } from "../src/jira/sync";

const SYNTHETIC_CREDS = {
  // demo.example.com (NOT the Atlassian sandbox host) — see file header: AC9 privacy grep.
  CONFLUENCE_URL: "https://demo.example.com",
  CONFLUENCE_EMAIL: "qa@example.com",
  CONFLUENCE_API_TOKEN: "synthetic-token",
} as unknown as NodeJS.ProcessEnv;

describe("buildAnswerJql (#1346 wiring)", () => {
  let savedTestMode: string | undefined;

  beforeEach(() => {
    savedTestMode = process.env.MONDAY_TEST_MODE;
    process.env.MONDAY_TEST_MODE = "1"; // deterministic stub mapper, no network.
  });

  afterEach(() => {
    if (savedTestMode === undefined) delete process.env.MONDAY_TEST_MODE;
    else process.env.MONDAY_TEST_MODE = savedTestMode;
    jest.restoreAllMocks();
  });

  it("happy path: injected fake search returns a JqlReply and the search WAS called (zero network)", async () => {
    const fakeIssues: JiraIssue[] = [
      { key: "DEMO-1", summary: "synthetic crash", descriptionText: "", commentTexts: [] },
    ];
    const fakeSearch: JqlSearchFetcher = {
      search: jest.fn(async (_jql: string) => fakeIssues),
    };
    // MUST-fix #2: prove no REAL network — assert global fetch is never invoked.
    const fetchSpy = jest.spyOn(globalThis, "fetch");

    const answer = buildAnswerJql({ env: SYNTHETIC_CREDS, search: fakeSearch });
    const reply = await answer("show me crashes");

    expect(typeof reply.jql).toBe("string");
    expect(reply.jql.length).toBeGreaterThan(0);
    // The auto-run path actually fired: the injected search was called once with the JQL.
    expect(fakeSearch.search).toHaveBeenCalledTimes(1);
    expect(fakeSearch.search).toHaveBeenCalledWith(reply.jql);
    expect(reply.issues).toEqual(fakeIssues);
    expect(Array.isArray(reply.warnings)).toBe(true);
    // Zero real network (MUST-fix #2 — mandatory, not optional).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no creds: returns the graceful 'not configured' JqlReply and never builds/uses the search", async () => {
    const fakeSearch = { search: jest.fn(async () => []) };
    // env MISSING CONFLUENCE_API_TOKEN → step-1 short-circuit before any fetcher.
    const env = {
      CONFLUENCE_URL: "https://demo.example.com",
      CONFLUENCE_EMAIL: "qa@example.com",
    } as unknown as NodeJS.ProcessEnv;

    const answer = buildAnswerJql({ env, search: fakeSearch });
    const reply = await answer("show me crashes");

    expect(reply).toEqual({
      jql: "",
      issues: [],
      warnings: ["Jira credentials are not configured."],
    });
    expect(fakeSearch.search).not.toHaveBeenCalled();
  });

  it("never throws on a completely empty env", async () => {
    const answer = buildAnswerJql({ env: {} as NodeJS.ProcessEnv });
    await expect(answer("anything")).resolves.toEqual({
      jql: "",
      issues: [],
      warnings: ["Jira credentials are not configured."],
    });
  });
});
