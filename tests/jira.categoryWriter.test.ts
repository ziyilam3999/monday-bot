import { buildJiraCategoryWriter } from "../src/jira/categoryWriter";

describe("buildJiraCategoryWriter — outward write (mocked, never live)", () => {
  it("AC-8: setCategory issues PUT /rest/api/3/issue/{key} with a labels-add body", async () => {
    const fakeResponse = {
      ok: true,
      status: 204,
      statusText: "No Content",
      async json() {
        return {};
      },
    };
    const fetchImpl = jest.fn(async () => fakeResponse) as unknown as typeof fetch;
    const writer = buildJiraCategoryWriter(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );

    await writer.setCategory("PROJ-42", "crash-error");

    expect((fetchImpl as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://example.atlassian.net/rest/api/3/issue/PROJ-42");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ update: { labels: [{ add: "defect-category:crash-error" }] } });
  });

  it("honors a configurable label prefix", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 204,
      statusText: "No Content",
      async json() {
        return {};
      },
    })) as unknown as typeof fetch;
    const writer = buildJiraCategoryWriter(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
      { labelPrefix: "kind" },
    );
    await writer.setCategory("PROJ-9", "display-ui");
    const init = (fetchImpl as unknown as jest.Mock).mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ update: { labels: [{ add: "kind:display-ui" }] } });
  });

  it("throws on a non-2xx response and on an empty issueKey", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      async json() {
        return {};
      },
    })) as unknown as typeof fetch;
    const writer = buildJiraCategoryWriter(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );
    await expect(writer.setCategory("PROJ-1", "other")).rejects.toThrow(/403/);
    await expect(writer.setCategory("", "other")).rejects.toThrow(TypeError);
  });
});
