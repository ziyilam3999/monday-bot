/**
 * #1372 Part A — jest wrapper that BINDS the hermetic post-merge hook smoke into
 * `npm test` (so the ubuntu CI leg provably runs it; AC-A6). It mirrors
 * tests/install-launchd.test.ts: the ONLY subprocess shells out to bash, and is
 * win32-skipped (bash + the launchctl shim aren't guaranteed on Windows CI).
 *
 * There is ZERO launchctl logic in this file. All gating is in the bash hook
 * (scripts/git-hooks/post-merge); all simulation is in the bash smoke
 * (tests/post-merge-hook-smoke.sh) + the PATH-shimmed launchctl
 * (tests/fixtures/launchctl-shim/launchctl). This wrapper only puts the shim on
 * PATH, runs the smoke, and asserts its exit code.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..");
const SMOKE = join(REPO_ROOT, "tests", "post-merge-hook-smoke.sh");
const SHIM_DIR = join(REPO_ROOT, "tests", "fixtures", "launchctl-shim");

describe("post-merge redeploy hook (#1372 Part A — hermetic launchctl-shim smoke)", () => {
  // bash + the shim aren't guaranteed on the Windows runner; skip there only —
  // on the ubuntu CI leg this RUNS (passes, not skipped), so the smoke cannot
  // silently go unrun (AC-A6).
  const maybe = process.platform === "win32" ? it.skip : it;

  maybe(
    "kickstarts exactly once when LOADED + source advanced; clean NO-OP when ABSENT or non-source",
    () => {
      expect(() =>
        execFileSync("bash", [SMOKE], {
          stdio: "pipe",
          env: { ...process.env, PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}` },
        }),
      ).not.toThrow();
    },
  );
});
