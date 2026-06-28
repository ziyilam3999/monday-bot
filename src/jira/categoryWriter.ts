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

/**
 * A Jira-label-safe prefix: lowercase alphanumerics joined by single internal
 * hyphens (matches the repo's slug convention). Rejects spaces, `@`, `/`, `:`,
 * uppercase, the empty string, and leading/trailing/double hyphens.
 */
const LABEL_PREFIX_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Fail-loud construction-time guard for `labelPrefix` (mirrors the issueKey
 * `TypeError` style). Throws before any PUT, so a malformed prefix can never be
 * stamped into a Jira label that would silently fail server-side.
 */
export function assertValidLabelPrefix(prefix: string): void {
  if (typeof prefix !== "string" || !LABEL_PREFIX_RE.test(prefix)) {
    throw new TypeError(
      `buildJiraCategoryWriter: labelPrefix ${JSON.stringify(prefix)} is not a valid Jira label prefix (lowercase alphanumerics with single internal hyphens)`,
    );
  }
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
  assertValidLabelPrefix(prefix);

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
