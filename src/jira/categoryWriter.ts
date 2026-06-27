import { JiraClientConfig, basicAuthHeader } from "./sync";

/**
 * OUTWARD-write seam: stamps a defect's category back onto its Jira issue.
 *
 * Dependency-injected (the `fetchImpl` is injectable) so the write path is
 * covered by a mocked fake in tests with ZERO live mutation. Default write is a
 * non-destructive, reversible `labels` ADD via `PUT /rest/api/3/issue/{key}`.
 * Constructed ONLY on the CLI `--apply` path — the dry-run default never builds
 * a writer, so it can issue no PUT.
 */
export interface JiraCategoryWriter {
  setCategory(issueKey: string, category: string): Promise<void>;
}

export interface JiraCategoryWriterOptions {
  /**
   * Label prefix for the category label (default `defect-category`). The stamped
   * label is `<prefix>:<category>` — a reversible add, not a replace.
   */
  labelPrefix?: string;
}

export function buildJiraCategoryWriter(
  config: JiraClientConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
  options: JiraCategoryWriterOptions = {},
): JiraCategoryWriter {
  if (typeof fetchImpl !== "function") {
    throw new TypeError(
      "buildJiraCategoryWriter: no global fetch available; pass an explicit fetchImpl",
    );
  }
  const base = config.baseUrl.replace(/\/$/, "");
  const prefix = options.labelPrefix ?? "defect-category";

  return {
    async setCategory(issueKey: string, category: string): Promise<void> {
      if (typeof issueKey !== "string" || issueKey.length === 0) {
        throw new TypeError("setCategory: issueKey must be a non-empty string");
      }
      const label = `${prefix}:${category}`;
      const url = `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
      const res = await fetchImpl(url, {
        method: "PUT",
        headers: {
          Authorization: basicAuthHeader(config),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        // Reversible labels ADD (does NOT replace the issue's other labels).
        body: JSON.stringify({ update: { labels: [{ add: label }] } }),
      });
      if (!res.ok) {
        throw new Error(
          `Jira REST API returned ${res.status} ${res.statusText} for PUT issue ${issueKey}`,
        );
      }
    },
  };
}
