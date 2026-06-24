#!/usr/bin/env node
/*
 * Tier-B golden eval (#1170 / #1195) — the HONEST before/after against the REAL corpus.
 *
 * PRIVACY (public repo): the real fixture (real UAT questions + real
 * ground-truth source ids + a real saved index dir) is NEVER committed. It is
 * supplied via the GOLDEN_EVAL_FIXTURE env var, pointing at a gitignored /
 * out-of-repo JSON file shaped like tests/fixtures/recall-eval/golden-private.example.json.
 *
 * SKIP-SAFE: when GOLDEN_EVAL_FIXTURE is unset, this prints a skip notice and
 * EXITS 0 — so public CI stays green without the private data.
 *
 * MODES:
 *   - Single-run (default, GOLDEN_EVAL_RUNS unset or =1): the original
 *     pass/fail rank+ground assertion. Exit non-zero on any FAIL.
 *   - N-run consistency (#1195, GOLDEN_EVAL_RUNS=N, N>1): runs each question N
 *     times against the REAL LLM and reports per-question RATES
 *     (ground / abstain / cites-gt / clean-decline / grounded-any) plus Q5-style
 *     determinism stability. This mode is a MEASUREMENT harness — it always
 *     exits 0 (the executor/operator reads the rate table); it never asserts a
 *     pass/fail threshold, because the both-ends RED→GREEN ACs are rate
 *     judgments captured live, not committed-CI gates.
 *
 * EXPECT modes per fixture question:
 *   - "clean-non-doc-reply" (or groundTruthSource: null without an expect): an
 *     abstention-bias control. The reply must carry 0 citations (clean decline).
 *   - "grounded-any": a SOFT ground expectation — the reply must be grounded
 *     (>=1 citation, non-abstain) but NO ground-truth-rank assertion (used when
 *     the pinned doc is unreachable for the phrasing; #1195 Q2).
 *   - default ("grounded"): HARD — the pinned ground-truth source must rank
 *     within topK AND the answer must cite it (grounded, not abstain).
 *
 * Run (single):  GOLDEN_EVAL_FIXTURE=/path/to/golden-private.json npm run eval:golden
 * Run (N-run):   GOLDEN_EVAL_RUNS=5 GOLDEN_EVAL_FIXTURE=/path npm run eval:golden
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ABSTAIN_OPENER = /^I couldn't find/i;
const HEDGE_OPENER = /no comprehensive list|couldn't find/i;

/** Classify ONE query result against a question spec. Pure, synthetic-safe. */
function classifyRun(q, res) {
  const gt = q.groundTruthSource;
  const answer = typeof res.answer === "string" ? res.answer : "";
  const citations = Array.isArray(res.citations) ? res.citations : [];
  const citationCount = citations.length;
  const abstain = ABSTAIN_OPENER.test(answer.trim());
  const citesGt = gt != null && citations.some((c) => c.source === gt);
  return {
    abstain,
    citesGt,
    citationCount,
    cleanDecline: citationCount === 0,
    grounded: citesGt && !abstain, // hard ground (cites the pinned gt)
    groundedAny: citationCount >= 1 && !abstain, // soft ground (any citation)
    phaseAware: citesGt && !abstain && !HEDGE_OPENER.test(answer.trim()),
  };
}

function pct(n, total) {
  return `${n}/${total}`;
}

async function main() {
  const fixturePath = process.env.GOLDEN_EVAL_FIXTURE;
  if (!fixturePath) {
    console.log(
      "eval:golden — SKIP: GOLDEN_EVAL_FIXTURE is not set. " +
        "This Tier-B eval needs the PRIVATE fixture (real UAT questions + pinned ground-truth ids), " +
        "which is never committed to this public repo. Set GOLDEN_EVAL_FIXTURE to run it locally. " +
        "Template shape: tests/fixtures/recall-eval/golden-private.example.json",
    );
    process.exit(0);
  }

  if (!fs.existsSync(fixturePath)) {
    console.error(`eval:golden — ERROR: GOLDEN_EVAL_FIXTURE points at a missing file: ${fixturePath}`);
    process.exit(1);
  }

  const RUNS = Math.max(1, parseInt(process.env.GOLDEN_EVAL_RUNS || "1", 10) || 1);

  const DIST = path.resolve(__dirname, "..", "dist");
  const { VectorIndex } = require(path.join(DIST, "index", "vectorIndex"));
  const { KnowledgeService } = require(path.join(DIST, "knowledge", "service"));
  const { loadConfig } = require(path.join(DIST, "config", "config"));

  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
  const questions = Array.isArray(fixture.questions) ? fixture.questions : [];
  if (questions.length === 0) {
    console.error("eval:golden — ERROR: fixture has no `questions` array.");
    process.exit(1);
  }

  // Build a service over the REAL saved index (shipped-default recall config).
  let recall;
  try {
    recall = loadConfig().recall;
  } catch {
    recall = undefined;
  }

  let index;
  if (fixture.indexDir && fs.existsSync(fixture.indexDir)) {
    index = new VectorIndex();
    await index.load(fixture.indexDir);
    console.log(`eval:golden — loaded real index from ${fixture.indexDir} (size=${index.size()})`);
  } else {
    console.error(
      "eval:golden — ERROR: fixture.indexDir is missing or does not exist. " +
        "Provide a directory holding an index.json saved via VectorIndex.save() over the real corpus.",
    );
    process.exit(1);
  }

  const service = new KnowledgeService({ index, recall });
  const topK = 12;

  // ---- N-run consistency mode (#1195) ---------------------------------------
  if (RUNS > 1) {
    console.log(`\n=== N-run consistency mode (N=${RUNS}, temperature per generate.ts) ===\n`);
    for (const q of questions) {
      const id = q.id || "?";
      const gt = q.groundTruthSource;
      const expect = q.expect || (gt == null ? "clean-non-doc-reply" : "grounded");

      // rank (deterministic retrieval) — computed once; ranking is not the LLM coin-flip.
      let rankLabel = "n/a";
      if (gt != null) {
        const hits = await service.retrieve(q.question);
        const rank = hits.findIndex((h) => h.source === gt) + 1;
        rankLabel = rank > 0 ? `#${rank}` : "OUTSIDE topK";
      }

      const tally = {
        abstain: 0,
        citesGt: 0,
        grounded: 0,
        groundedAny: 0,
        cleanDecline: 0,
        phaseAware: 0,
      };
      const outcomes = []; // for determinism stability
      for (let i = 0; i < RUNS; i++) {
        const res = await service.query(q.question);
        const c = classifyRun(q, res);
        if (c.abstain) tally.abstain++;
        if (c.citesGt) tally.citesGt++;
        if (c.grounded) tally.grounded++;
        if (c.groundedAny) tally.groundedAny++;
        if (c.cleanDecline) tally.cleanDecline++;
        if (c.phaseAware) tally.phaseAware++;
        // Stability category: ground vs abstain vs other (ignores exact wording).
        outcomes.push(c.grounded ? "ground" : c.abstain ? "abstain" : "other");
      }

      // Modal-outcome stability (AC-DET): biggest single category count.
      const counts = outcomes.reduce((m, o) => ((m[o] = (m[o] || 0) + 1), m), {});
      const modal = Math.max(...Object.values(counts));

      if (expect === "clean-non-doc-reply") {
        console.log(
          `${id}  [control: abstain-expected]  clean-decline ${pct(tally.cleanDecline, RUNS)} ` +
            `(0 citations); abstain ${pct(tally.abstain, RUNS)}`,
        );
      } else if (expect === "grounded-any") {
        console.log(
          `${id}  [soft: grounded-any]  grounded-any ${pct(tally.groundedAny, RUNS)} ` +
            `(>=1 cite, non-abstain); abstain ${pct(tally.abstain, RUNS)}; gt-rank ${rankLabel} (not asserted)`,
        );
      } else {
        console.log(
          `${id}  [hard: grounded]  gt=${gt} rank ${rankLabel}; ` +
            `cites-gt ${pct(tally.citesGt, RUNS)}; grounded ${pct(tally.grounded, RUNS)}; ` +
            `abstain ${pct(tally.abstain, RUNS)}; phase-aware(no-hedge) ${pct(tally.phaseAware, RUNS)}; ` +
            `stability(modal ground/abstain/other) ${pct(modal, RUNS)}`,
        );
      }
    }
    console.log(
      "\neval:golden — N-run consistency report complete (measurement mode; exit 0, no threshold gate).",
    );
    process.exit(0);
  }

  // ---- Single-run pass/fail mode (original, committed-CI shape) --------------
  let fail = 0;
  for (const q of questions) {
    const id = q.id || "?";
    const question = q.question;
    const gt = q.groundTruthSource;
    const expect = q.expect || (gt == null ? "clean-non-doc-reply" : "grounded");

    if (expect === "clean-non-doc-reply") {
      // Abstention-bias control: a chit-chat / borderline off-topic question
      // must yield a clean reply with no spurious citations.
      const res = await service.query(question);
      const cited = Array.isArray(res.citations) ? res.citations.length : 0;
      const ok = cited === 0;
      console.log(`${id}: control (abstain-expected) — citations=${cited} -> ${ok ? "PASS" : "FAIL"}`);
      if (!ok) fail++;
      continue;
    }

    if (expect === "grounded-any") {
      // Soft ground: any citation + non-abstain; NO ground-truth-rank assertion.
      const res = await service.query(question);
      const c = classifyRun(q, res);
      const ok = c.groundedAny;
      console.log(
        `${id}: grounded-any — citations=${c.citationCount}, abstain=${c.abstain} -> ${ok ? "PASS" : "FAIL"}`,
      );
      if (!ok) fail++;
      continue;
    }

    const hits = await service.retrieve(question);
    const rank = hits.findIndex((h) => h.source === gt) + 1; // within-topK only
    const withinTopK = rank > 0 && rank <= topK;
    const res = await service.query(question);
    const cited = (res.citations || []).some((c) => c.source === gt);
    const grounded = cited && !res.answer.startsWith("I couldn't find");

    const ok = withinTopK && grounded;
    console.log(
      `${id}: ground-truth ${gt} -> rank ${rank > 0 ? "#" + rank : "OUTSIDE topK"} ` +
        `(within topK? ${withinTopK}); grounded(cites gt, not abstain)? ${grounded} -> ${ok ? "PASS" : "FAIL"}`,
    );
    if (!ok) fail++;
  }

  console.log("");
  if (fail > 0) {
    console.error(`eval:golden — RESULT: FAIL (${fail} question(s) failed)`);
    process.exit(1);
  }
  console.log("eval:golden — RESULT: PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("eval:golden — crashed:", err);
  process.exit(1);
});
