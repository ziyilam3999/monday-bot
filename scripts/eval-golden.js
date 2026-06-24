#!/usr/bin/env node
/*
 * Tier-B golden eval (#1170) — the HONEST before/after against the REAL corpus.
 *
 * PRIVACY (public repo): the real fixture (5 real UAT questions + real
 * ground-truth source ids + a real saved index dir) is NEVER committed. It is
 * supplied via the GOLDEN_EVAL_FIXTURE env var, pointing at a gitignored /
 * out-of-repo JSON file shaped like tests/fixtures/recall-eval/golden-private.example.json.
 *
 * SKIP-SAFE: when GOLDEN_EVAL_FIXTURE is unset, this prints a skip notice and
 * EXITS 0 — so public CI stays green without the private data.
 *
 * This is the mechanical prevention for
 * feedback_recall_validation_must_pin_true_ground_truth_doc_not_heuristic_top_prose:
 * rank is asserted against a PINNED ground-truth source id, never a heuristic
 * "plausible top prose page".
 *
 * Run:  GOLDEN_EVAL_FIXTURE=/path/to/golden-private.json npm run eval:golden
 */
"use strict";

const fs = require("fs");
const path = require("path");

async function main() {
  const fixturePath = process.env.GOLDEN_EVAL_FIXTURE;
  if (!fixturePath) {
    console.log(
      "eval:golden — SKIP: GOLDEN_EVAL_FIXTURE is not set. " +
        "This Tier-B eval needs the PRIVATE fixture (5 real UAT questions + pinned ground-truth ids), " +
        "which is never committed to this public repo. Set GOLDEN_EVAL_FIXTURE to run it locally. " +
        "Template shape: tests/fixtures/recall-eval/golden-private.example.json",
    );
    process.exit(0);
  }

  if (!fs.existsSync(fixturePath)) {
    console.error(`eval:golden — ERROR: GOLDEN_EVAL_FIXTURE points at a missing file: ${fixturePath}`);
    process.exit(1);
  }

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

  let fail = 0;
  for (const q of questions) {
    const id = q.id || "?";
    const question = q.question;
    const gt = q.groundTruthSource;
    const hits = await service.retrieve(question);
    const rank = hits.findIndex((h) => h.source === gt) + 1; // within-topK only

    if (gt === null || q.expect === "clean-non-doc-reply") {
      // Abstention-bias control: a chit-chat question must yield a clean reply
      // with no spurious citations.
      const res = await service.query(question);
      const cited = Array.isArray(res.citations) ? res.citations.length : 0;
      const ok = cited === 0;
      console.log(`${id}: control (no doc) — citations=${cited} -> ${ok ? "PASS" : "FAIL"}`);
      if (!ok) fail++;
      continue;
    }

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
