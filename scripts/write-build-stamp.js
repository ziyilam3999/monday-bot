#!/usr/bin/env node
/**
 * write-build-stamp.js — Layer 2 of the stale-`dist/` prevention (task #1348).
 *
 * Runs as the SECOND half of `npm run build` (`tsc && node scripts/write-build-stamp.js`),
 * i.e. only AFTER a GREEN `tsc`. It writes the single-line build-stamp the bot reads
 * back at startup so the running build is identifiable from the logs alone.
 *
 * Build-stamp contract (the single source of truth the ACs grep):
 *   file:  dist/.build-stamp
 *   shape: sha=<short-sha> built=<iso-timestamp>\n
 *   e.g.   sha=a1b2c3d built=2026-06-28T12:34:56Z
 *
 * Privacy (PUBLIC repo): SHA + UTC timestamp ONLY. No paths, hostnames,
 * usernames, branch names, or tokens.
 *
 * Configurable (env, never hardcoded magic):
 *   BUILD_STAMP_SHA       override the short SHA (default: `git rev-parse --short HEAD`)
 *   BUILD_STAMP_BUILT     override the ISO timestamp (default: now, UTC, no millis)
 *   BUILD_STAMP_DIST_DIR  override the dist dir (default: <repo>/dist)
 */
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function shortSha() {
  if (process.env.BUILD_STAMP_SHA) return process.env.BUILD_STAMP_SHA;
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Contract requires >= 7 lowercase-hex chars. git's --short is >= 7 by default.
    if (/^[0-9a-f]{7,}$/.test(sha)) return sha;
  } catch {
    /* fall through to the well-formed placeholder below */
  }
  // No git metadata (e.g. a tarball export): keep the file CONTRACT-VALID rather
  // than emitting a malformed stamp. Seven zeros is valid lowercase hex.
  return "0000000";
}

function builtTimestamp() {
  if (process.env.BUILD_STAMP_BUILT) return process.env.BUILD_STAMP_BUILT;
  // UTC ISO-8601, strip milliseconds so it matches the contract's
  // `built=[0-9TZ:-]+$` anchor (a `.` would break the grep).
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function main() {
  const distDir =
    process.env.BUILD_STAMP_DIST_DIR || path.join(__dirname, "..", "dist");
  const sha = shortSha();
  const built = builtTimestamp();
  const line = `sha=${sha} built=${built}\n`;

  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, ".build-stamp"), line, "utf8");
  // Echo so the build log shows the stamp that was written.
  process.stdout.write(`build-stamp written: sha=${sha} built=${built}\n`);
}

main();
