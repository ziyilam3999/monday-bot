import { run } from "../src/triage/cli";
import { buildOpenDefectsFetcher } from "../src/jira/sync";
import type { JiraCategoryWriter } from "../src/jira/categoryWriter";
import type { JiraIssue } from "../src/jira/sync";

/** Two synthetic open defects, both with keys (so --apply has something to write). */
const FIXTURE_ISSUES: JiraIssue[] = [
  { key: "X-1", summary: "the app crashed on launch", descriptionText: "", commentTexts: [], issueType: "Bug" },
  { key: "X-2", summary: "the running total shows the wrong amount", descriptionText: "", commentTexts: [], issueType: "Bug" },
];

/** A writer spy whose setCategory is bound to a fake — NEVER live Jira. */
function makeWriterSpy(): { writer: JiraCategoryWriter; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const writer: JiraCategoryWriter = {
    async setCategory(issueKey, category) {
      calls.push([issueKey, category]);
    },
  };
  return { writer, calls };
}

describe("run(deps) — dry-run default + flag-gated outward write (AC-7)", () => {
  it("dry-run (no --apply) makes ZERO writes", async () => {
    const { writer, calls } = makeWriterSpy();
    const logs: string[] = [];
    const result = await run({
      fetchOpenDefects: async () => FIXTURE_ISSUES,
      writer,
      apply: false,
      log: (m) => logs.push(m),
    });
    expect(calls).toHaveLength(0);
    expect(result.applied).toBe(0);
    // The tally is still printed in dry-run.
    expect(logs.some((l) => l.startsWith("Category tally:"))).toBe(true);
  });

  it("--apply (same injected fake) makes a NON-ZERO number of writes", async () => {
    const { writer, calls } = makeWriterSpy();
    const result = await run({
      fetchOpenDefects: async () => FIXTURE_ISSUES,
      writer,
      apply: true,
      log: () => undefined,
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(result.applied).toBe(FIXTURE_ISSUES.length);
    // Each write stamps the computed category for that key.
    expect(calls).toEqual([
      ["X-1", "crash-error"],
      ["X-2", "data-incorrect"],
    ]);
  });

  it("dry-run with the read seam bound to a FAKE fetchImpl still issues no write", async () => {
    // Read seam driven by an injected fake fetchImpl (no live network); writer
    // is a spy. Proves both ends bind to fakes.
    const rawIssue = {
      key: "X-9",
      fields: { summary: "the feed is slow and laggy", description: null, comment: { comments: [] } },
    };
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return { issues: [rawIssue], isLast: true };
      },
    })) as unknown as typeof fetch;
    const fetcher = buildOpenDefectsFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      {},
      fetchImpl,
    );
    const { writer, calls } = makeWriterSpy();
    const result = await run({
      fetchOpenDefects: () => fetcher.fetchOpenDefects("PROJ"),
      writer,
      apply: false,
      log: () => undefined,
    });
    expect(calls).toHaveLength(0);
    expect(result.counts.performance).toBe(1);
  });
});
