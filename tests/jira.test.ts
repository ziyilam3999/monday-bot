import {
  JiraSync,
  JiraFetcher,
  JiraIssue,
  buildJiraFetcher,
  adfToText,
} from "../src/jira/sync";
import { KnowledgeService } from "../src/knowledge/service";

jest.setTimeout(30_000);

function makeStubFetcher(issuesByProject: Record<string, JiraIssue[]>): JiraFetcher {
  return {
    async fetchIssues(projectKey: string) {
      return issuesByProject[projectKey] ?? [];
    },
  };
}

/** Build a minimal ADF paragraph node wrapping the given text. */
function adfParagraph(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

describe("JiraSync module exports", () => {
  it("exports a JiraSync class with a syncProject method", () => {
    expect(typeof JiraSync).toBe("function");
    const fetcher = makeStubFetcher({});
    const knowledge = new KnowledgeService();
    const sync = new JiraSync({ knowledge, fetcher });
    expect(typeof sync.syncProject).toBe("function");
  });

  it("rejects construction without knowledge or fetcher", () => {
    expect(
      () =>
        new JiraSync({} as unknown as { knowledge: KnowledgeService; fetcher: JiraFetcher }),
    ).toThrow(TypeError);
  });
});

describe("JiraSync.syncProject happy path", () => {
  it("routes each fetched issue through KnowledgeService.indexConfluencePage", async () => {
    const knowledge = new KnowledgeService();
    const issues: JiraIssue[] = [
      {
        key: "PROJ-1",
        summary: "Login bug",
        descriptionText: "Users cannot log in.",
        commentTexts: ["Reproduced on staging."],
        projectKey: "PROJ",
      },
      {
        key: "PROJ-2",
        summary: "Slow dashboard",
        descriptionText: "Dashboard takes 10s to load.",
        commentTexts: [],
        projectKey: "PROJ",
      },
    ];
    const fetcher = makeStubFetcher({ PROJ: issues });
    const sync = new JiraSync({ knowledge, fetcher });

    const result = await sync.syncProject("PROJ");

    expect(result.projectKey).toBe("PROJ");
    expect(result.issuesIndexed).toBe(2);
    expect(result.issuesFailed).toBe(0);
    expect(knowledge.getStatus().documentCount).toBe(2);
    expect(knowledge.getChunkCountForSource("jira:PROJ-1")).toBe(1);
    expect(knowledge.getChunkCountForSource("jira:PROJ-2")).toBe(1);
  });

  it("indexed issue body is answerable (summary + description + comments)", async () => {
    const knowledge = new KnowledgeService();
    const issues: JiraIssue[] = [
      {
        key: "PROJ-9",
        summary: "Payment gateway timeout",
        descriptionText: "The checkout fails with a timeout error.",
        commentTexts: ["Workaround: retry after 30 seconds."],
      },
    ];
    const fetcher = makeStubFetcher({ PROJ: issues });
    const sync = new JiraSync({ knowledge, fetcher });
    await sync.syncProject("PROJ");
    expect(knowledge.getChunkCountForSource("jira:PROJ-9")).toBe(1);
  });

  it("counts failures without aborting the rest of the batch", async () => {
    const knowledge = new KnowledgeService();
    const indexSpy = jest
      .spyOn(knowledge, "indexConfluencePage")
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => undefined);

    const issues: JiraIssue[] = [
      { key: "PROJ-1", summary: "A", descriptionText: "first", commentTexts: [] },
      { key: "PROJ-2", summary: "B", descriptionText: "second", commentTexts: [] },
    ];
    const fetcher = makeStubFetcher({ PROJ: issues });
    const errorLog = jest.fn();
    const sync = new JiraSync({ knowledge, fetcher, logger: { error: errorLog } });

    const result = await sync.syncProject("PROJ");
    expect(result.issuesIndexed).toBe(1);
    expect(result.issuesFailed).toBe(1);
    expect(indexSpy).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("rejects empty projectKey", async () => {
    const knowledge = new KnowledgeService();
    const fetcher = makeStubFetcher({});
    const sync = new JiraSync({ knowledge, fetcher });
    await expect(sync.syncProject("")).rejects.toThrow(TypeError);
  });

  it("re-syncing the same issue dedupes by source (jira:<KEY>)", async () => {
    const knowledge = new KnowledgeService();
    const v1: JiraIssue[] = [
      { key: "PROJ-5", summary: "Bug", descriptionText: "v1 body", commentTexts: [] },
    ];
    const v2: JiraIssue[] = [
      { key: "PROJ-5", summary: "Bug", descriptionText: "v2 body", commentTexts: [] },
    ];
    const state: { current: JiraIssue[] } = { current: v1 };
    const fetcher: JiraFetcher = {
      async fetchIssues() {
        return state.current;
      },
    };
    const sync = new JiraSync({ knowledge, fetcher });
    await sync.syncProject("PROJ");
    expect(knowledge.getChunkCountForSource("jira:PROJ-5")).toBe(1);
    state.current = v2;
    await sync.syncProject("PROJ");
    expect(knowledge.getChunkCountForSource("jira:PROJ-5")).toBe(1);
  });
});

describe("adfToText (ADF → plaintext)", () => {
  it("flattens a paragraph of text nodes", () => {
    const node = adfParagraph("Hello world");
    expect(adfToText(node)).toBe("Hello world");
  });

  it("joins block nodes with newlines and tolerates nested content", () => {
    const node = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First line" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
      ],
    };
    const out = adfToText(node);
    expect(out).toContain("First line");
    expect(out).toContain("Second line");
    expect(out).not.toContain("type");
    expect(out).not.toContain("paragraph");
  });

  it("tolerates null, undefined, and plain-string descriptions", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
    expect(adfToText("just a plain string")).toBe("just a plain string");
  });
});

describe("buildJiraFetcher (HTTP wiring + ADF mapping)", () => {
  it("maps an ADF description + comment to plaintext, Basic auth, JQL url at site root", async () => {
    const rawIssue = {
      key: "PROJ-42",
      fields: {
        summary: "Cannot reset password",
        description: adfParagraph("The reset link expires too quickly"),
        comment: {
          comments: [{ body: adfParagraph("Bumped the TTL to one hour") }],
        },
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
    const fetcher = buildJiraFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );

    const issues = await fetcher.fetchIssues("PROJ");
    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe("PROJ-42");
    expect(issues[0].summary).toBe("Cannot reset password");
    expect(issues[0].descriptionText).toContain("reset link expires");
    expect(issues[0].descriptionText).not.toContain("type");
    expect(issues[0].commentTexts).toHaveLength(1);
    expect(issues[0].commentTexts[0]).toContain("Bumped the TTL");
    expect(issues[0].projectKey).toBe("PROJ");

    const callArgs = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    const url = callArgs[0] as string;
    const init = callArgs[1] as { headers: Record<string, string> };
    // New JQL search endpoint at the site ROOT — no /wiki, not the removed /search?.
    expect(url).toContain("/rest/api/3/search/jql");
    expect(url).not.toContain("/wiki");
    expect(url).toContain("jql=");
    expect(decodeURIComponent(url)).toContain("project=PROJ");
    expect(url).toContain("maxResults=100");
    // First request carries no cursor.
    expect(url).not.toContain("nextPageToken");
    expect(init.headers.Authorization).toMatch(/^Basic /);
  });

  it("paginates via nextPageToken and STOPS on isLast:true", async () => {
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
            fields: { summary: `Issue ${start + i}`, description: null, comment: { comments: [] } },
          })),
        };
      },
    });
    // Page 1 hands back cursor "t1"; page 2 is the last page (no cursor).
    const responses = [page(0, 100, "t1", false), page(100, 100, undefined, true)];
    let call = 0;
    const fetchImpl = jest.fn(async () => responses[call++]) as unknown as typeof fetch;

    const fetcher = buildJiraFetcher(
      { baseUrl: "https://example.atlassian.net/", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );
    const issues = await fetcher.fetchIssues("PROJ");

    // 100 + 100 accumulated; loop stops on isLast:true (no 3rd fetch).
    expect(issues).toHaveLength(200);
    expect((fetchImpl as unknown as jest.Mock).mock.calls).toHaveLength(2);

    const urls = (fetchImpl as unknown as jest.Mock).mock.calls.map((c) => c[0] as string);
    // First request omits the cursor; second carries nextPageToken=t1.
    expect(urls[0]).not.toContain("nextPageToken");
    expect(urls[1]).toContain("nextPageToken=t1");
  });

  it("throws on non-2xx HTTP", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      async json() {
        return {};
      },
    })) as unknown as typeof fetch;
    const fetcher = buildJiraFetcher(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );
    await expect(fetcher.fetchIssues("PROJ")).rejects.toThrow(/401/);
  });
});
