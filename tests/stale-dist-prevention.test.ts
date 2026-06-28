/**
 * #1348 — stale-`dist/` prevention (3 layers).
 *
 * Content/structure checks for the committed PUBLIC-repo-safe artifacts plus a
 * real execution of the build-stamp writer (node is cross-platform, so this runs
 * identically on the CI ubuntu + windows matrix). The behavioral launchd-wrapper
 * proofs (forced-build-fail fallback, exit-code isolation, cold-start backoff)
 * are macOS shell smokes run at ship time — CI never runs launchctl.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..");
const REDEPLOY = join(REPO_ROOT, "scripts", "redeploy-local.sh");
const WRAPPER = join(REPO_ROOT, "scripts", "launchd-wrapper.sh");
const STAMP_WRITER = join(REPO_ROOT, "scripts", "write-build-stamp.js");

const redeploy = readFileSync(REDEPLOY, "utf8");
const wrapper = readFileSync(WRAPPER, "utf8");
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

// Contract grep anchors (must match the plan's Build-stamp contract exactly).
const STAMP_FILE_RE = /^sha=[0-9a-f]{7,} built=[0-9TZ:-]+$/;
const COLD_FAIL_LINE =
  "build-stamp: COLD-START FAILURE — no last-good dist and build failed; cannot start";

const maybeBash = process.platform === "win32" ? it.skip : it;

describe("Layer 1 — redeploy wiring (AC-1)", () => {
  it("npm run redeploy resolves to the redeploy script", () => {
    expect(pkg.scripts.redeploy).toBeDefined();
    expect(pkg.scripts.redeploy).toContain("scripts/redeploy-local.sh");
  });

  it("build step writes the build-stamp", () => {
    expect(pkg.scripts.build).toContain("write-build-stamp");
  });

  it("verifies LIVE freshness by PID-change + stamp-SHA==HEAD, no dir-mtime compare (AC-2/N1)", () => {
    expect(redeploy).toContain("set -uo pipefail"); // NOT set -e (build rc must not abort verify)
    expect(redeploy).toMatch(/rev-parse --short HEAD/);
    expect(redeploy).toMatch(/build-stamp: sha=/); // parses the live stamp line
    expect(redeploy).toMatch(/PID did not change/i); // (a) restart proof
    expect(redeploy).toMatch(/MISMATCH|stale/i); // (b) stale keyword on failure
    // No directory-mtime comparison in the actual logic (a `stat`-based mtime read).
    expect(redeploy).not.toMatch(/stat\b.*(-c|-f).*%[Ym]/);
  });
});

describe("Layer 2 — build-stamp writer (AC-3)", () => {
  it("emits dist/.build-stamp matching the contract grep anchor", () => {
    const dir = mkdtempSync(join(tmpdir(), "stamp-"));
    try {
      execFileSync(process.execPath, [STAMP_WRITER], {
        env: { ...process.env, BUILD_STAMP_DIST_DIR: dir },
        stdio: "pipe",
      });
      const line = readFileSync(join(dir, ".build-stamp"), "utf8").trim();
      expect(line).toMatch(STAMP_FILE_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours configurable BUILD_STAMP_SHA / BUILD_STAMP_BUILT overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "stamp-"));
    try {
      execFileSync(process.execPath, [STAMP_WRITER], {
        env: {
          ...process.env,
          BUILD_STAMP_DIST_DIR: dir,
          BUILD_STAMP_SHA: "a1b2c3d",
          BUILD_STAMP_BUILT: "2026-06-28T12:34:56Z",
        },
        stdio: "pipe",
      });
      const line = readFileSync(join(dir, ".build-stamp"), "utf8").trim();
      expect(line).toBe("sha=a1b2c3d built=2026-06-28T12:34:56Z");
      expect(line).toMatch(STAMP_FILE_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Layer 3 — launchd wrapper structure (AC-7/8/9/10)", () => {
  it("execs node so wrapper-exit == node-exit (no build status leak, M2/AC-9)", () => {
    expect(wrapper).toContain("set -uo pipefail"); // NOT set -e
    expect(wrapper).toMatch(/exec "\$\{NODE_BIN\}"/);
    // The forbidden antipattern (returning the BUILD's status to KeepAlive) must
    // not appear as real code — only the exec'd node's status ever propagates.
    // (The header comment documents the antipattern by name; strip comments first.)
    const code = wrapper
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/exit\s+\$\{?build_rc\}?/);
  });

  it("skips the rebuild when dist is fresh for HEAD (N2 single build owner)", () => {
    expect(wrapper).toMatch(/rev-parse --short HEAD/);
    expect(wrapper).toMatch(/skipping rebuild/i);
  });

  it("falls back to last-good on a failed build without clobbering it (AC-7/8)", () => {
    expect(wrapper).toMatch(/LAST-GOOD/);
    expect(wrapper).toMatch(/promote_last_good/);
    // last-good is a SEPARATE dir from dist, so a failed build can't overwrite it.
    expect(wrapper).toContain("dist-last-good");
  });

  it("cold-start emits the fixed line, counts, and backs off bounded (M3/AC-10)", () => {
    expect(wrapper).toContain(COLD_FAIL_LINE);
    expect(wrapper).toContain(".cold-fail-count");
    expect(wrapper).toMatch(/COLD_FAIL_BACKOFF_BASE/);
    expect(wrapper).toMatch(/COLD_FAIL_BACKOFF_MAX/);
    expect(wrapper).toMatch(/COLD_FAIL_MAX_RETRIES/);
  });

  it("bakes in NO real machine paths (PUBLIC repo)", () => {
    expect(wrapper).not.toMatch(/\/Users\//);
    expect(redeploy).not.toMatch(/\/Users\//);
  });
});

describe("syntax — the new shell scripts parse", () => {
  maybeBash("redeploy-local.sh passes bash -n", () => {
    expect(() => execFileSync("bash", ["-n", REDEPLOY], { stdio: "pipe" })).not.toThrow();
  });
  maybeBash("launchd-wrapper.sh passes bash -n", () => {
    expect(() => execFileSync("bash", ["-n", WRAPPER], { stdio: "pipe" })).not.toThrow();
  });
});
