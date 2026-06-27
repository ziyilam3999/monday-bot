import {
  buildOpenDefectsFetcher,
  buildOpenDefectsJql,
  JiraIssue,
} from "../src/jira/sync";

/** Minimal ADF paragraph node wrapping the given text. */
function adfParagraph(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

describe("buildOpenDefectsJql (open-defects scope, configurable)", () => {
  it("defaults to a generic open + defect scope", () => {
    expect(buildOpenDefectsJql("PROJ")).toBe(
      "project=PROJ AND statusCategory != Done AND issuetype in (Bug)",
    );
  });

  it("honors overrides and drops an empty-string clause", () => {
    expect(
      buildOpenDefectsJql("PROJ", { statusJql: "status = Open", issueTypeJql: "" }),
    ).toBe("project=PROJ AND status = Open");
  });
});

describe("buildOpenDefectsFetcher (constructed from the shared helper)", () => {
  it("AC-11: extended mapping surfaces labels + issueType from a fixture issue", async () => {
    const rawIssue = {
      key: "PROJ-7",
      fields: {
        summary: "defect with labels and a type",
        description: adfParagraph("a body"),
        comment: { comments: [] },
        labels: ["x", "y"],
        issuetype: { name: "Bug" },
        project: { key: "PROJ" },
      },
    };
    const fakeResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return { issues: [rawIssue], isLast: true };
      },
    };
    const fetchImpl = jest.fn(async () => fakeResponse) as unknown as typeof fetch;
    const fetcher = buildOpenDefectsFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      {},
      fetchImpl,
    );

    const issues = await fetcher.fetchOpenDefects("PROJ");
    expect(issues).toHaveLength(1);
    expect(issues[0].labels).toEqual(["x", "y"]);
    expect(issues[0].issueType).toBe("Bug");

    // The fetch URL carries the open-defects JQL + the extra fields.
    const url = (fetchImpl as unknown as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain("/rest/api/3/search/jql");
    expect(decodeURIComponent(url)).toContain("statusCategory != Done");
    expect(decodeURIComponent(url)).toContain("issuetype in (Bug)");
    expect(url).toContain("fields=summary,description,comment,labels,issuetype");
  });

  it("AC-11 (backward-compat): an issue lacking labels/issuetype yields undefined", async () => {
    const rawIssue = {
      key: "PROJ-8",
      fields: {
        summary: "defect without labels or type",
        description: null,
        comment: { comments: [] },
      },
    };
    const fakeResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return { issues: [rawIssue], isLast: true };
      },
    };
    const fetchImpl = jest.fn(async () => fakeResponse) as unknown as typeof fetch;
    const fetcher = buildOpenDefectsFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      {},
      fetchImpl,
    );
    const issues = await fetcher.fetchOpenDefects("PROJ");
    expect(issues[0].labels).toBeUndefined();
    expect(issues[0].issueType).toBeUndefined();
  });

  it("paginates via the SAME shared cursor loop (nextPageToken, stops on isLast)", async () => {
    const page = (
      start: number,
      count: number,
      nextPageToken: string | undefined,
      isLast: boolean,
    ) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return {
          nextPageToken,
          isLast,
          issues: Array.from({ length: count }, (_, i) => ({
            key: `PROJ-${start + i}`,
            fields: { summary: `Defect ${start + i}`, description: null, comment: { comments: [] } },
          })) as unknown[],
        };
      },
    });
    const responses = [page(0, 100, "t1", false), page(100, 50, undefined, true)];
    let call = 0;
    const fetchImpl = jest.fn(async () => responses[call++]) as unknown as typeof fetch;
    const fetcher = buildOpenDefectsFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      {},
      fetchImpl,
    );
    const issues: JiraIssue[] = await fetcher.fetchOpenDefects("PROJ");
    expect(issues).toHaveLength(150);
    const urls = (fetchImpl as unknown as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(urls[0]).not.toContain("nextPageToken");
    expect(urls[1]).toContain("nextPageToken=t1");
  });
});
