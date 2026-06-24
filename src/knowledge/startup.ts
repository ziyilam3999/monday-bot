import { KnowledgeService } from "./service";
import { AppConfig } from "../config/config";
import {
  ConfluenceSync,
  ConfluenceFetcher,
  buildConfluenceFetcher,
} from "../confluence/sync";
import { JiraSync, JiraFetcher, buildJiraFetcher } from "../jira/sync";

/** Default periodic re-sync cadence: every 6 hours. */
export const DEFAULT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A scheduled timer handle. `clear()` cancels the periodic callback. */
export interface ScheduledTimer {
  clear: () => void;
}

/** Schedules `cb` every `ms` and returns a clearable handle. Injectable for tests. */
export type Scheduler = (cb: () => void, ms: number) => ScheduledTimer;

export interface KnowledgeSourcesLogger {
  info?: (msg: string) => void;
  error?: (msg: string, err?: unknown) => void;
}

export interface KnowledgeSourcesDeps {
  knowledge: KnowledgeService;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `{}`. */
  config?: AppConfig;
  /** Injectable Confluence fetcher (tests). Defaults to a real one built from env. */
  confluenceFetcher?: ConfluenceFetcher;
  /** Injectable Jira fetcher (tests). Defaults to a real one built from env. */
  jiraFetcher?: JiraFetcher;
  /** Injectable scheduler (tests). Defaults to an unref'd setInterval wrapper. */
  scheduler?: Scheduler;
  logger?: KnowledgeSourcesLogger;
}

export interface KnowledgeSourcesHandle {
  /** Clears every scheduled timer. Idempotent. */
  stop(): void;
  /** Resolves once all initial syncs have settled (never rejects). */
  ready: Promise<void>;
  /**
   * On-demand Confluence re-sync. Re-syncs the given space (if provided) or all
   * configured spaces. Returns a human-readable summary; never throws (errors
   * are caught + returned as a summary). "Confluence is not configured" when no
   * Confluence sync is wired (no creds OR no CONFLUENCE_SPACES).
   */
  syncConfluence(spaceKey?: string): Promise<string>;
  /**
   * Re-run every configured Confluence space + Jira project. Returns a summary;
   * never throws. Note: watched folders are kept live continuously by the folder
   * watchers and KnowledgeService exposes no on-demand folder-rescan method, so
   * reindexAll intentionally covers Confluence + Jira only.
   */
  reindexAll(): Promise<string>;
}

/** Default scheduler: an unref'd setInterval so it never blocks process exit. */
const defaultScheduler: Scheduler = (cb, ms) => {
  const timer = setInterval(cb, ms);
  if (typeof timer.unref === "function") timer.unref();
  return { clear: () => clearInterval(timer) };
};

/** Split a comma-separated env value into trimmed, non-empty tokens. */
function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Strip a trailing `/wiki` (and any trailing slash) from a Confluence URL to get
 * the Atlassian SITE ROOT. `buildConfluenceFetcher` re-appends `/wiki/rest/...`
 * and `buildJiraFetcher` appends `/rest/api/3`, so BOTH must receive the site
 * root — passing the raw `/wiki` URL would double it (plan-review fix A).
 */
function toSiteRoot(url: string): string {
  return url.replace(/\/wiki\/?$/, "").replace(/\/$/, "");
}

/**
 * Wire Confluence + Jira knowledge sources into the running KnowledgeService.
 *
 * Reads credentials/targets from env ONLY (the repo is public). When creds are
 * present, builds the relevant sync, kicks off an initial sync per space/project
 * and schedules a periodic re-sync. Missing creds → logged once + skipped (no
 * throw). Initial sync errors are caught + logged, never rejected/thrown, so
 * startup is non-blocking and non-fatal (plan-review fix D).
 */
export function startKnowledgeSources(deps: KnowledgeSourcesDeps): KnowledgeSourcesHandle {
  const env = deps.env ?? process.env;
  const config = deps.config ?? {};
  const scheduler = deps.scheduler ?? defaultScheduler;
  const logger = deps.logger ?? {};
  const log = (msg: string): void => {
    if (logger.info) logger.info(msg);
    else console.log(msg);
  };

  const timers: ScheduledTimer[] = [];
  const initialSyncs: Array<Promise<unknown>> = [];

  // Hoisted so the returned handle can reach them for on-demand re-sync. These
  // stay `undefined`/empty unless the corresponding source is actually wired
  // (creds present AND a non-empty space/project list).
  let confluenceSync: ConfluenceSync | undefined;
  const confluenceSpaces: string[] = [];
  let jiraSync: JiraSync | undefined;
  const jiraProjects: string[] = [];

  const intervalMs = resolveIntervalMs(config);

  // ── Confluence ──────────────────────────────────────────────────────────
  const confluenceUrl = env.CONFLUENCE_URL ?? env.CONFLUENCE_BASE_URL;
  const email = env.CONFLUENCE_EMAIL;
  const apiToken = env.CONFLUENCE_API_TOKEN;
  const haveAtlassianCreds = Boolean(confluenceUrl && email && apiToken);
  const siteRoot = confluenceUrl ? toSiteRoot(confluenceUrl) : "";

  if (haveAtlassianCreds) {
    const spaces = splitList(env.CONFLUENCE_SPACES);
    if (spaces.length === 0) {
      log("Confluence sync: no CONFLUENCE_SPACES configured, skipping");
    } else {
      const fetcher =
        deps.confluenceFetcher ??
        buildConfluenceFetcher({
          baseUrl: siteRoot,
          email: email!,
          apiToken: apiToken!,
          // Configurable page size (default 100 inside buildConfluenceFetcher).
          // Not a full large-space fix — cursor pagination is deferred (#1189).
          pageLimit: config.confluence?.pageLimit,
        });
      const sync = new ConfluenceSync({ knowledge: deps.knowledge, fetcher, logger });
      confluenceSync = sync;
      confluenceSpaces.push(...spaces);
      for (const space of spaces) {
        initialSyncs.push(
          sync
            .syncSpace(space)
            .then((res) => log(`confluence:${space} indexed ${res.pagesIndexed} pages`))
            .catch((err) => {
              if (logger.error) logger.error(`Confluence initial sync failed for ${space}`, err);
              else console.error(`Confluence initial sync failed for ${space}:`, err);
            }),
        );
        timers.push(
          scheduler(() => {
            sync.syncSpace(space).catch((err) => {
              if (logger.error) logger.error(`Confluence re-sync failed for ${space}`, err);
              else console.error(`Confluence re-sync failed for ${space}:`, err);
            });
          }, intervalMs),
        );
      }
    }
  } else {
    log("Confluence sync disabled (creds not set)");
  }

  // ── Jira ────────────────────────────────────────────────────────────────
  // Jira reuses the Atlassian creds (CONFLUENCE_URL/EMAIL/API_TOKEN) + needs
  // its own JIRA_PROJECTS list.
  const projects = splitList(env.JIRA_PROJECTS);
  if (haveAtlassianCreds && projects.length > 0) {
    const fetcher =
      deps.jiraFetcher ??
      buildJiraFetcher({ baseUrl: siteRoot, email: email!, apiToken: apiToken! });
    const sync = new JiraSync({ knowledge: deps.knowledge, fetcher, logger });
    jiraSync = sync;
    jiraProjects.push(...projects);
    for (const project of projects) {
      initialSyncs.push(
        sync
          .syncProject(project)
          .then((res) => log(`jira:${project} indexed ${res.issuesIndexed} issues`))
          .catch((err) => {
            if (logger.error) logger.error(`Jira initial sync failed for ${project}`, err);
            else console.error(`Jira initial sync failed for ${project}:`, err);
          }),
      );
      timers.push(
        scheduler(() => {
          sync.syncProject(project).catch((err) => {
            if (logger.error) logger.error(`Jira re-sync failed for ${project}`, err);
            else console.error(`Jira re-sync failed for ${project}:`, err);
          });
        }, intervalMs),
      );
    }
  } else if (!haveAtlassianCreds) {
    log("Jira sync disabled (creds not set)");
  } else {
    log("Jira sync: no JIRA_PROJECTS configured, skipping");
  }

  // `ready` resolves once every initial sync has settled — never rejects.
  const ready = Promise.allSettled(initialSyncs).then(() => undefined);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const t of timers) {
      try {
        t.clear();
      } catch {
        // best-effort
      }
    }
    timers.length = 0;
  };

  /**
   * On-demand Confluence re-sync — covers BOTH no-creds AND creds-but-no-spaces
   * (confluenceSync stays undefined in both cases). Non-throwing.
   */
  const syncConfluence = async (spaceKey?: string): Promise<string> => {
    if (!confluenceSync) return "Confluence is not configured";
    const sync = confluenceSync;
    const targets = spaceKey && spaceKey.length > 0 ? [spaceKey] : confluenceSpaces;
    try {
      const parts: string[] = [];
      for (const space of targets) {
        const res = await sync.syncSpace(space);
        parts.push(`${space} (${res.pagesIndexed} pages)`);
      }
      return `Re-synced confluence: ${parts.join(", ")}`;
    } catch (err) {
      return `Confluence sync failed: ${(err as Error)?.message ?? "unknown error"}`;
    }
  };

  /**
   * Re-run every configured Confluence space + Jira project. Handles partial
   * config (confluence-only / jira-only) and reports each configured source.
   * Non-throwing. Watched folders are intentionally excluded — folder watchers
   * keep them live continuously and KnowledgeService exposes no folder-rescan.
   */
  const reindexAll = async (): Promise<string> => {
    try {
      const parts: string[] = [];
      if (confluenceSync) {
        const sync = confluenceSync;
        let pages = 0;
        for (const space of confluenceSpaces) {
          const res = await sync.syncSpace(space);
          pages += res.pagesIndexed;
        }
        parts.push(`confluence ${pages} pages`);
      }
      if (jiraSync) {
        const sync = jiraSync;
        let issues = 0;
        for (const project of jiraProjects) {
          const res = await sync.syncProject(project);
          issues += res.issuesIndexed;
        }
        parts.push(`jira ${issues} issues`);
      }
      if (parts.length === 0) return "Nothing configured to reindex";
      return `Reindexed: ${parts.join(", ")}`;
    } catch (err) {
      return `Reindex failed: ${(err as Error)?.message ?? "unknown error"}`;
    }
  };

  return { stop, ready, syncConfluence, reindexAll };
}

/**
 * Resolve the periodic re-sync interval. We keep this simple — no cron-parser
 * dependency. A recognizable numeric "every N hours" hint in the config could be
 * honored later; for now any present schedule maps to the 6h default.
 */
function resolveIntervalMs(config: AppConfig): number {
  void config; // schedule fields are documentation-only today; see plan note.
  return DEFAULT_SYNC_INTERVAL_MS;
}
