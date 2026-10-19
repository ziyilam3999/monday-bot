#!/usr/bin/env node
/**
 * 3286 sync-responsive runner (plain node — NEVER jest; jest's
 * moduleNameMapper stubs the embedder with code that cannot block, so any
 * jest-measured loop/handler bound passes vacuously — plan decision 2).
 *
 * PREREQUISITE: `npm run build` FIRST. This runner drives the COMPILED
 * production sync path under dist/ (KnowledgeService + ConfluenceSync/JiraSync
 * via startKnowledgeSources) with the REAL embedding backend and checked-in
 * fixtures — plan-review r2 finding 1. Run `npm run build` before every
 * invocation of this script.
 *
 * Modes:
 *   probe  — measure one full fixture-scale sync: event-loop delay histogram,
 *            per-channel handler-latency stand-ins on the same loop, a mid-sync
 *            query() (stub generator), and exactly one `dominant-stall:` line
 *            naming the plan's decision-rule row the receipt picks (AC-2).
 *   bound  — same measurement core, ENFORCING the responsiveness contract:
 *            max handler latency <= 1000ms AND max event-loop delay <= 1000ms
 *            AND the mid-sync query resolving BEFORE the sync completes.
 *            Exit non-zero on violation (AC-5).
 *   store  — store I/O bound at >= 5,000 passages / >= 20 MB (AC-6). Ships with
 *            Part B; this mode refuses + reports "not in Part A" when the
 *            fixture target IS set.
 *
 * Refuse rule (standing): SMOKE_FIXTURES must name the fixture corpus dir.
 * Unset -> exit 1 naming the unset target. The runner never falls back to a
 * live Jira/Confluence/Slack/Telegram/LLM target; fetchers and the generator
 * are fixture stubs injected through the production constructor seams.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");

const USAGE = [
  "usage: node scripts/sync-responsive-smoke.js <probe|bound|store>",
  "  PREREQUISITE: npm run build   (runner drives dist/ — plan-review r2 F1)",
  "  SMOKE_FIXTURES must point at the fixture corpus dir, e.g.",
  "    SMOKE_FIXTURES=tests/fixtures/sync-responsive node scripts/sync-responsive-smoke.js probe",
].join("\n");

const REFUSE_MSG =
  "refusing to run: SMOKE_FIXTURES is unset — no fixture target named. " +
  "Set it to the fixture corpus dir (tests/fixtures/sync-responsive). " +
  "This harness never falls back to a live Jira/Confluence/Slack/Telegram/LLM target.";

const BOUND_MS = 1000;
const WAKE_INTERVAL_MS = 200;
const SPACE_KEY = "SR";
const PROJECT_KEY = "SR";
const MID_SYNC_QUERY = "what is the deployment release window for the current quarter?";

function fail(msg, code) {
  console.error(msg);
  process.exit(code);
}

function refuseIfNoFixtures() {
  if (!process.env.SMOKE_FIXTURES || process.env.SMOKE_FIXTURES.trim() === "") {
    fail(REFUSE_MSG, 1);
  }
}

/** Per-channel handler-latency stand-in: a rescheduling timer on the same loop
 * measures wake delay (scheduled vs actual) — the plan's stand-in for the Slack
 * and Telegram handlers, which run on this loop in production. */
function startWakeStandalone(state) {
  const stops = [];
  for (const channel of Object.keys(state)) {
    const s = state[channel];
    let stopped = false;
    const tick = () => {
      const at = performance.now();
      setTimeout(() => {
        if (stopped) return;
        const delay = performance.now() - at - WAKE_INTERVAL_MS;
        s.samples++;
        if (s.samples > 2) s.max = Math.max(s.max, delay); // drop warm-up wakes
        tick();
      }, WAKE_INTERVAL_MS);
    };
    tick();
    stops.push(() => {
      stopped = true;
    });
  }
  return () => stops.forEach((f) => f());
}

function loadDist() {
  const distMarker = path.join(__dirname, "..", "dist", "knowledge", "startup.js");
  if (!fs.existsSync(distMarker)) {
    fail(
      "dist/ is not built — run `npm run build` first (plan-review r2 F1 prerequisite).\n" + USAGE,
      2,
    );
  }
  return {
    KnowledgeService: require("../dist/knowledge/service.js").KnowledgeService,
    VectorIndex: require("../dist/index/vectorIndex.js").VectorIndex,
    startKnowledgeSources: require("../dist/knowledge/startup.js").startKnowledgeSources,
    splitIntoPassages: require("../dist/ingestion/chunkText.js").splitIntoPassages,
  };
}

function loadFixtures(fixturesDir) {
  const pagesPath = path.join(fixturesDir, "confluence-pages.json");
  const issuesPath = path.join(fixturesDir, "jira-issues.json");
  if (!fs.existsSync(pagesPath) || !fs.existsSync(issuesPath)) {
    fail(`refusing to run: fixture corpus incomplete under ${fixturesDir} (need confluence-pages.json + jira-issues.json)`, 1);
  }
  const pages = JSON.parse(fs.readFileSync(pagesPath, "utf8"));
  const issues = JSON.parse(fs.readFileSync(issuesPath, "utf8"));
  if (pages.length + issues.length < 60) {
    fail(
      `refusing to run: fixture corpus has ${pages.length + issues.length} docs; the plan floor is 60 docs / 300 passages`,
      1,
    );
  }
  return { pages, issues };
}

/**
 * Decision rule (plan r2): classify the receipt into exactly one row.
 * Reachable rows with this probe design are R0/R1/R2 (and R4's parse leg in
 * principle); R3 (store save/load — dead code at HEAD), R5 (real Slack client
 * receive path — stand-ins here) and R6 (DNS/threadpool — fetchers are stubs,
 * so no DNS happens) are NOT observable by this probe: the receipt says so
 * instead of guessing (plan-review r2 finding 3).
 */
function classify(loopMaxMs, handlerMaxMs, cpuBusyRatio) {
  if (loopMaxMs <= BOUND_MS && handlerMaxMs <= BOUND_MS) return "R0";
  // Stall reproduced (>1s somewhere). With stub fetchers the awaited work in
  // the sync window is embedding (off-node-thread, but onnxruntime intra-op
  // threads compete for cores) plus synchronous passage chunking. CPU-pegged
  // during embed bursts is the R2 signature; loop delay without saturation is
  // R1's cooperative-yield case.
  return cpuBusyRatio >= 0.85 ? "R2" : "R1";
}

/** The shared measurement core: one full fixture-scale sync through the
 * production wiring, monitored. Returns the receipt fields. */
async function runSyncMeasurement(dist, fixturesDir) {
  const { pages, issues } = loadFixtures(fixturesDir);

  // Fixture stub fetchers — the ONLY data source. Throw on anything but the
  // fixture space/project so a wiring mistake can never silently pass.
  const confluenceFetcher = {
    async fetchPages(spaceKey) {
      if (spaceKey !== SPACE_KEY) throw new Error(`fixture fetcher: unexpected space "${spaceKey}"`);
      return pages;
    },
  };
  const jiraFetcher = {
    async fetchIssues(projectKey) {
      if (projectKey !== PROJECT_KEY) throw new Error(`fixture fetcher: unexpected project "${projectKey}"`);
      return issues;
    },
  };

  const index = new dist.VectorIndex();
  // Stub generator (no LLM): the generator is out of scope for responsiveness
  // bounds; KnowledgeService's constructor seam injects it (plan decision 2).
  const generator = async (question) => ({ answer: `stub answer: ${question}`, citations: [] });
  const knowledge = new dist.KnowledgeService({ index, generator });

  const hist = monitorEventLoopDelay({ resolution: 20 });
  const handlerState = { slack: { max: 0, samples: 0 }, telegram: { max: 0, samples: 0 } };
  const stopWakes = startWakeStandalone(handlerState);

  const cpuBefore = process.cpuUsage();
  const t0 = performance.now();
  hist.enable();

  const sources = dist.startKnowledgeSources({
    knowledge,
    env: {
      CONFLUENCE_URL: "https://fixture.example.invalid/wiki",
      CONFLUENCE_EMAIL: "fixtures@example.invalid",
      CONFLUENCE_API_TOKEN: "fixture-placeholder-not-a-credential",
      CONFLUENCE_SPACES: SPACE_KEY,
      JIRA_PROJECTS: PROJECT_KEY,
    },
    confluenceFetcher,
    jiraFetcher,
    // Record-only scheduler: the 6h periodic re-sync is not part of this
    // measurement window (no real timer is armed).
    scheduler: (_cb, _ms) => ({ clear() {} }),
    logger: {
      info: () => {},
      error: (msg, err) => console.error("sync-error:", msg, err instanceof Error ? err.message : err),
    },
  });

  // Mid-sync query: wait until the FIRST doc is indexed (partial beats
  // refusal), then race query() against the sync's completion.
  let midSync = { issued: false, resolvedBeforeSync: null, latencyMs: null, docsAtIssue: 0 };
  const queryPromise = (async () => {
    const deadline = performance.now() + 10 * 60 * 1000;
    while (performance.now() < deadline) {
      if (index.size() > 0) {
        const qs = performance.now();
        midSync.issued = true;
        midSync.docsAtIssue = knowledge.getStatus().documentCount;
        await knowledge.query(MID_SYNC_QUERY);
        midSync.latencyMs = performance.now() - qs;
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();

  await sources.ready;
  const readyAt = performance.now();
  const queryDone = await queryPromise.then(() => performance.now());
  if (midSync.issued && midSync.latencyMs !== null) {
    midSync.resolvedBeforeSync = queryDone <= readyAt;
  }

  const wallMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpuBefore);
  hist.disable();
  stopWakes();
  sources.stop();

  const loopMaxMs = hist.max / 1e6;
  const loopP99Ms = hist.percentile(99) / 1e6;
  const cores = os.cpus().length;
  const cpuBusyRatio = (cpu.user + cpu.system) / 1e3 / wallMs / cores;
  const handlerMaxMs = Math.max(handlerState.slack.max, handlerState.telegram.max);

  // Pre-chunk with the production splitter to report the corpus passage count.
  let passageCount = 0;
  for (const p of pages) passageCount += dist.splitIntoPassages(p.body.trim()).length;
  for (const it of issues) {
    const body = [it.key, it.summary, it.descriptionText, ...it.commentTexts].filter(Boolean).join("\n\n");
    passageCount += dist.splitIntoPassages(body.trim()).length;
  }

  return {
    docs: pages.length + issues.length,
    docsIndexed: knowledge.getStatus().documentCount,
    passages: passageCount,
    chunksInIndex: index.size(),
    wallMs,
    loopMaxMs,
    loopP99Ms,
    handlerSlackMaxMs: handlerState.slack.max,
    handlerTelegramMaxMs: handlerState.telegram.max,
    handlerSlackSamples: handlerState.slack.samples,
    handlerTelegramSamples: handlerState.telegram.samples,
    handlerMaxMs,
    cpuBusyRatio,
    cores,
    midSync,
  };
}

function printReceipt(mode, r) {
  const round = (x) => Math.round(x * 10) / 10;
  console.log(`receipt: mode=${mode} docs=${r.docs} docsIndexed=${r.docsIndexed} passages=${r.passages} chunksInIndex=${r.chunksInIndex}`);
  console.log(`wall: ${Math.round(r.wallMs)}ms (${round(r.wallMs / Math.max(1, r.chunksInIndex))}ms per embedded chunk)`);
  console.log(`loop-delay: max=${round(r.loopMaxMs)}ms p99=${round(r.loopP99Ms)}ms`);
  console.log(
    `handler-latency: slack max=${round(r.handlerSlackMaxMs)}ms (n=${r.handlerSlackSamples}) telegram max=${round(r.handlerTelegramMaxMs)}ms (n=${r.handlerTelegramSamples})`,
  );
  console.log(`cpu: busyRatio=${r.cpuBusyRatio.toFixed(2)} of ${r.cores} cores`);
  console.log(
    `mid-sync query: issued=${r.midSync.issued} atDocs=${r.midSync.docsAtIssue} latencyMs=${r.midSync.latencyMs === null ? "n/a" : Math.round(r.midSync.latencyMs)} resolvedBeforeSync=${r.midSync.resolvedBeforeSync}`,
  );
  const row = classify(r.loopMaxMs, r.handlerMaxMs, r.cpuBusyRatio);
  console.log(`dominant-stall: ${row}`);
  console.log(
    "notes: rows R3 (store save/load is dead code at HEAD), R5 (real Slack client receive path; stand-in timers here) and R6 (DNS/threadpool; fixture fetchers make no network calls) are unreachable by this probe design — plan-review r2 finding 3; the row above claims only what this machine measured",
  );
  return row;
}

async function main() {
  const mode = process.argv[2];
  if (!mode || !["probe", "bound", "store"].includes(mode)) {
    fail("missing or unknown mode\n" + USAGE, 2);
  }
  refuseIfNoFixtures();

  if (mode === "store") {
    // AC-6 (>= 5,000 passages / >= 20 MB, <= 250ms loop delay per save AND
    // load) ships with Part B; Part A wires only the refuse rule (AC-4).
    fail("store mode: the store I/O bound ships with Part B (AC-6, #3286) — not implemented in Part A", 2);
  }

  const dist = loadDist();
  const fixturesDir = process.env.SMOKE_FIXTURES.trim();
  const r = await runSyncMeasurement(dist, fixturesDir);
  const row = printReceipt(mode, r);

  if (mode === "bound") {
    const violations = [];
    if (r.loopMaxMs > BOUND_MS) violations.push(`max event-loop delay ${Math.round(r.loopMaxMs)}ms > ${BOUND_MS}ms`);
    if (r.handlerMaxMs > BOUND_MS) violations.push(`max handler latency ${Math.round(r.handlerMaxMs)}ms > ${BOUND_MS}ms`);
    if (r.midSync.resolvedBeforeSync !== true) violations.push("mid-sync query did not resolve before the sync completed");
    if (violations.length > 0) {
      for (const v of violations) console.error("BOUND VIOLATION: " + v);
      process.exit(1);
    }
    console.log(`bound: PASS (loop delay + handler latency <= ${BOUND_MS}ms; mid-sync query resolved first)`);
  }
}

main().catch((err) => {
  console.error("runner failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
