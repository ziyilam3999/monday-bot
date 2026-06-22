import { KnowledgeService } from "../knowledge/service";

/**
 * Jira sync: pulls issues (summary + description + comments) from a Jira project
 * via the Atlassian REST API and routes each issue through
 * `KnowledgeService.indexConfluencePage` — the generic single-doc index path —
 * under a stable `jira:<KEY>` source so a re-sync replaces (rather than
 * accumulates) the prior version.
 *
 * Mirrors `src/confluence/sync.ts`: the HTTP fetcher is injected so tests drive
 * the module without real network calls. Production wiring builds a fetcher
 * around `globalThis.fetch` targeting
 * `<baseUrl>/rest/api/3/search/jql?jql=project=<KEY>&fields=summary,description,comment`
 * and flips through pages via the `nextPageToken` cursor the endpoint returns.
 */

export interface JiraIssue {
  key: string;
  summary: string;
  descriptionText: string;
  commentTexts: string[];
  projectKey?: string;
}

/**
 * Lowest-common-denominator fetcher signature. Returns the issues for a project
 * (paginated + ADF-flattened by the real impl, or the stubbed equivalent in
 * tests).
 */
export interface JiraFetcher {
  fetchIssues(projectKey: string): Promise<JiraIssue[]>;
}

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraSyncOptions {
  knowledge: KnowledgeService;
  fetcher: JiraFetcher;
  /** Optional logger; defaults to a quiet no-op. */
  logger?: { info?: (msg: string) => void; error?: (msg: string, err?: unknown) => void };
}

export interface JiraSyncResult {
  projectKey: string;
  issuesIndexed: number;
  issuesFailed: number;
}

/**
 * Recursively flatten an Atlassian Document Format (ADF) node tree to plain
 * text. ADF appears in issue descriptions and comment bodies. Tolerates a node
 * that is a plain string, a `{ type: "text", text }` leaf, a container with a
 * `content` array, or null/undefined.
 *
 * Block-level nodes are joined with newlines; inline nodes with the empty
 * string. Excess whitespace is collapsed and the result trimmed.
 */
const ADF_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "listItem",
  "bulletList",
  "orderedList",
  "blockquote",
  "codeBlock",
]);

export function adfToText(node: unknown): string {
  return collapse(walkAdf(node));
}

function walkAdf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";

  const n = node as { type?: unknown; text?: unknown; content?: unknown };

  if (n.type === "text" && typeof n.text === "string") {
    return n.text;
  }

  if (Array.isArray(n.content)) {
    const isBlock = typeof n.type === "string" && ADF_BLOCK_TYPES.has(n.type);
    const sep = isBlock ? "\n" : "";
    return (n.content as unknown[]).map(walkAdf).join(sep);
  }

  return "";
}

function collapse(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n *\n+ */g, "\n")
    .replace(/ *\n */g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Build a `JiraFetcher` backed by the real Atlassian REST API. Hits
 * `GET <baseUrl>/rest/api/3/search/jql?jql=project=<KEY>&fields=summary,description,comment&maxResults=100`
 * with Basic auth (email + API token). Paginates via the `nextPageToken` cursor:
 * the first request omits the token, each response returns
 * `{ issues, nextPageToken, isLast }`, and subsequent requests append
 * `&nextPageToken=<token>`. Stops when `isLast === true` OR no token is returned.
 * Description and comment bodies are ADF objects (or plain strings / null) and
 * are flattened to text.
 *
 * Not used by tests — tests inject a stub fetcher OR a fake `fetchImpl`. Exposed
 * so the scheduler / CLI can wire production usage in one line.
 */
export function buildJiraFetcher(
  config: JiraClientConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): JiraFetcher {
  if (typeof fetchImpl !== "function") {
    throw new TypeError(
      "buildJiraFetcher: no global fetch available; pass an explicit fetchImpl",
    );
  }
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  const base = config.baseUrl.replace(/\/$/, "");
  const MAX_RESULTS = 100;
  // Hard cap on pages walked — defends against a server that never sets
  // `isLast` and keeps echoing a cursor (1000 pages * 100 = 100k issues).
  const MAX_PAGES = 1000;

  return {
    async fetchIssues(projectKey: string): Promise<JiraIssue[]> {
      const out: JiraIssue[] = [];
      let token: string | undefined;
      let pages = 0;
      // Cursor pagination: the first request omits the token; each response
      // returns the next page's cursor. Stop on `isLast === true` OR no token.
      for (;;) {
        let url =
          `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(`project=${projectKey}`)}` +
          `&fields=summary,description,comment&maxResults=${MAX_RESULTS}`;
        if (token) url += `&nextPageToken=${encodeURIComponent(token)}`;
        const res = await fetchImpl(url, {
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: "application/json",
          },
        });
        if (!res.ok) {
          throw new Error(
            `Jira REST API returned ${res.status} ${res.statusText} for project=${projectKey}`,
          );
        }
        const data = (await res.json()) as {
          issues?: unknown;
          nextPageToken?: unknown;
          isLast?: unknown;
        };
        const issues = Array.isArray(data.issues) ? data.issues : [];
        for (const raw of issues) {
          const mapped = toJiraIssue(raw);
          if (mapped) out.push(mapped);
        }
        token = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
        pages++;
        // Primary stop: the server says this was the last page, or no cursor.
        if (data.isLast === true || !token) break;
        // Loop guards (server misbehaving): bail after a sane page cap, and on a
        // 0-issue page that still hands back a token (would otherwise spin).
        if (pages >= MAX_PAGES) break;
        if (issues.length === 0) break;
      }
      return out;
    },
  };
}

function toJiraIssue(raw: unknown): JiraIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as {
    key?: unknown;
    fields?: {
      summary?: unknown;
      description?: unknown;
      comment?: { comments?: unknown };
      project?: { key?: unknown };
    };
  };
  if (typeof r.key !== "string" || r.key.length === 0) return null;
  const fields = r.fields ?? {};
  const summary = typeof fields.summary === "string" ? fields.summary : "";
  const descriptionText = adfToText(fields.description);
  const rawComments = Array.isArray(fields.comment?.comments) ? fields.comment!.comments! : [];
  const commentTexts = (rawComments as Array<{ body?: unknown }>).map((c) =>
    adfToText(c?.body),
  );
  const issue: JiraIssue = { key: r.key, summary, descriptionText, commentTexts };
  if (typeof fields.project?.key === "string") issue.projectKey = fields.project.key;
  return issue;
}

export class JiraSync {
  private readonly knowledge: KnowledgeService;
  private readonly fetcher: JiraFetcher;
  private readonly logger: NonNullable<JiraSyncOptions["logger"]>;

  constructor(opts: JiraSyncOptions) {
    if (!opts || !opts.knowledge || !opts.fetcher) {
      throw new TypeError("JiraSync: knowledge and fetcher are required");
    }
    this.knowledge = opts.knowledge;
    this.fetcher = opts.fetcher;
    this.logger = opts.logger ?? {};
  }

  /**
   * Sync every issue in `projectKey` into the knowledge index. Re-syncing the
   * same issue replaces (rather than duplicates) the prior version because each
   * issue lands under a stable `jira:<KEY>` source identifier.
   */
  async syncProject(projectKey: string): Promise<JiraSyncResult> {
    if (typeof projectKey !== "string" || projectKey.length === 0) {
      throw new TypeError("JiraSync.syncProject: projectKey must be a non-empty string");
    }
    const issues = await this.fetcher.fetchIssues(projectKey);
    let issuesIndexed = 0;
    let issuesFailed = 0;
    for (const issue of issues) {
      try {
        const body = [
          issue.key,
          issue.summary,
          issue.descriptionText,
          ...issue.commentTexts,
        ]
          .filter(Boolean)
          .join("\n\n");
        await this.knowledge.indexConfluencePage({
          id: issue.key,
          title: issue.summary,
          body,
          source: `jira:${issue.key}`,
          spaceKey: issue.projectKey ?? projectKey,
        });
        issuesIndexed++;
      } catch (err) {
        issuesFailed++;
        if (this.logger.error) {
          this.logger.error(`JiraSync: failed to index issue ${issue.key}`, err);
        } else {
          // eslint-disable-next-line no-console
          console.error(`JiraSync: failed to index issue ${issue.key}:`, err);
        }
      }
    }
    if (this.logger.info) {
      this.logger.info(
        `JiraSync: projectKey=${projectKey} indexed=${issuesIndexed} failed=${issuesFailed}`,
      );
    }
    return { projectKey, issuesIndexed, issuesFailed };
  }
}
