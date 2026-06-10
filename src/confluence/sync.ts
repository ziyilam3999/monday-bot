import { KnowledgeService, ConfluencePageInput } from "../knowledge/service";

/**
 * Confluence sync: pulls pages from a Confluence space via the REST API and
 * routes each page through `KnowledgeService.indexConfluencePage` so the same
 * `source` identifier replaces (rather than accumulates) prior versions on
 * re-sync.
 *
 * The HTTP fetcher is injected so tests can drive the module without real
 * network calls. Production wiring builds a fetcher around `globalThis.fetch`
 * targeting `<baseUrl>/wiki/rest/api/content?spaceKey=<KEY>&expand=body.storage`.
 */

export interface ConfluencePage extends ConfluencePageInput {
  id: string;
  body: string;
}

/**
 * Lowest-common-denominator fetcher signature. Returns the parsed JSON body of
 * `<baseUrl>/wiki/rest/api/content?spaceKey=<KEY>&expand=body.storage` (or the
 * stubbed equivalent in tests). Real impl strips HTML from `body.storage.value`
 * before yielding `ConfluencePage`s.
 */
export interface ConfluenceFetcher {
  fetchPages(spaceKey: string): Promise<ConfluencePage[]>;
}

export interface ConfluenceSyncOptions {
  knowledge: KnowledgeService;
  fetcher: ConfluenceFetcher;
  /** Optional logger; defaults to a quiet no-op. */
  logger?: { info?: (msg: string) => void; error?: (msg: string, err?: unknown) => void };
}

export interface ConfluenceSyncResult {
  spaceKey: string;
  pagesIndexed: number;
  pagesFailed: number;
}

export interface ConfluenceClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

/**
 * Build a `ConfluenceFetcher` backed by real Atlassian REST API. Hits
 * `GET <baseUrl>/wiki/rest/api/content?spaceKey=<KEY>&expand=body.storage` with
 * Basic auth (email + API token). Strips HTML to plain text.
 *
 * Not used by tests — tests inject a stub fetcher directly. Exposed so the
 * scheduler / CLI can wire production usage in one line.
 */
export function buildConfluenceFetcher(
  config: ConfluenceClientConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): ConfluenceFetcher {
  if (typeof fetchImpl !== "function") {
    throw new TypeError(
      "buildConfluenceFetcher: no global fetch available; pass an explicit fetchImpl",
    );
  }
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  return {
    async fetchPages(spaceKey: string): Promise<ConfluencePage[]> {
      const url = `${config.baseUrl.replace(/\/$/, "")}/wiki/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&expand=body.storage&limit=100`;
      const res = await fetchImpl(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        throw new Error(
          `Confluence REST API returned ${res.status} ${res.statusText} for spaceKey=${spaceKey}`,
        );
      }
      const data = (await res.json()) as { results?: unknown };
      const results = Array.isArray(data.results) ? data.results : [];
      return results.map(toConfluencePage).filter((p): p is ConfluencePage => p !== null);
    },
  };
}

function toConfluencePage(raw: unknown): ConfluencePage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as {
    id?: unknown;
    title?: unknown;
    body?: { storage?: { value?: unknown } };
    space?: { key?: unknown };
  };
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  const title = typeof r.title === "string" ? r.title : "";
  const html = typeof r.body?.storage?.value === "string" ? r.body!.storage!.value! : "";
  const body = stripHtml(html);
  const spaceKey = typeof r.space?.key === "string" ? r.space!.key! : undefined;
  const page: ConfluencePage = {
    id: r.id,
    title,
    body,
    source: `confluence:${r.id}`,
  };
  if (spaceKey !== undefined) page.spaceKey = spaceKey;
  return page;
}

function stripHtml(html: string): string {
  // Quick-and-correct-enough HTML→text for retrieval. Production-grade DOM
  // parsing isn't worth the dep here; the embedder is robust to leftover noise.
  //
  // Ordering is correctness-load-bearing and must stay:
  //   1. drop <style>/<script> blocks (their text content is noise),
  //   2. strip remaining tags,
  //   3. THEN decode entities.
  // If entity-decode ran before tag-strip, an encoded `&lt;script&gt;` payload
  // inside text would materialize as a real `<script>` substring and survive
  // tag-stripping with its body intact. See ordering test in
  // tests/confluence.test.ts ("stripHtml ordering").
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

export class ConfluenceSync {
  private readonly knowledge: KnowledgeService;
  private readonly fetcher: ConfluenceFetcher;
  private readonly logger: NonNullable<ConfluenceSyncOptions["logger"]>;

  constructor(opts: ConfluenceSyncOptions) {
    if (!opts || !opts.knowledge || !opts.fetcher) {
      throw new TypeError("ConfluenceSync: knowledge and fetcher are required");
    }
    this.knowledge = opts.knowledge;
    this.fetcher = opts.fetcher;
    this.logger = opts.logger ?? {};
  }

  /**
   * Sync every page in `spaceKey` into the knowledge index. Re-syncing the same
   * page replaces (rather than duplicates) the prior version because each page
   * lands under a stable `confluence:<id>` source identifier.
   */
  async syncSpace(spaceKey: string): Promise<ConfluenceSyncResult> {
    if (typeof spaceKey !== "string" || spaceKey.length === 0) {
      throw new TypeError("ConfluenceSync.syncSpace: spaceKey must be a non-empty string");
    }
    const pages = await this.fetcher.fetchPages(spaceKey);
    let pagesIndexed = 0;
    let pagesFailed = 0;
    for (const page of pages) {
      try {
        await this.knowledge.indexConfluencePage({
          id: page.id,
          title: page.title,
          body: page.body,
          source: page.source ?? `confluence:${page.id}`,
          spaceKey: page.spaceKey ?? spaceKey,
        });
        pagesIndexed++;
      } catch (err) {
        pagesFailed++;
        if (this.logger.error) {
          this.logger.error(`ConfluenceSync: failed to index page ${page.id}`, err);
        } else {
          // eslint-disable-next-line no-console
          console.error(`ConfluenceSync: failed to index page ${page.id}:`, err);
        }
      }
    }
    if (this.logger.info) {
      this.logger.info(
        `ConfluenceSync: spaceKey=${spaceKey} indexed=${pagesIndexed} failed=${pagesFailed}`,
      );
    }
    return { spaceKey, pagesIndexed, pagesFailed };
  }
}
