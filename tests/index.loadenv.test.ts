/**
 * #1165 — `.env` loading on the CLI entry path.
 *
 * The bot's `npm start` is `node dist/index.js`; nothing used to load `.env`,
 * so `validateEnv()` threw "Missing required environment variables" even when
 * `.env` was correctly filled. The fix calls `process.loadEnvFile()` (native,
 * dependency-free, guarded by try/catch) as the first statement inside the
 * `if (require.main === module)` CLI-entry block.
 *
 * These are child-process spawn tests: we run the BUILT `dist/index.js` in a
 * temp cwd, because `process.loadEnvFile()` only fires on the CLI entry path
 * (require.main === module), which jest's in-process import never triggers.
 *
 * (G1) The suite builds `dist/` in `beforeAll` so it validates CURRENT source
 *      and is self-contained (bare `npm test` does not build).
 * (G2) Case (a) scrubs SLACK_* by `delete`, not spread-undefined, so a leaked
 *      literal "undefined" string can't false-green the test — the temp `.env`
 *      is the only token source.
 * (G3) Assertions read STDOUT only; a non-fatal pdfjs DOMMatrix warning prints
 *      on stderr at startup and is ignored.
 */

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.setTimeout(120_000);

const REPO_ROOT = join(__dirname, "..");
const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");
const READY_LOG = "Monday is listening (Socket Mode)";

const tmpDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `monday-loadenv-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

beforeAll(() => {
  // (G1) Build dist before spawning — bare `npm test` does not build, and the
  // child reads dist/index.js. CI builds first, but this keeps the test
  // self-contained locally and guarantees the dist reflects CURRENT source.
  // Use execSync (runs through a shell) so `npm` resolves on every platform —
  // execFileSync("npm.cmd", …) trips Node's Windows batch-file-without-shell
  // guard and throws a circular Error that jest can't serialize.
  execSync("npm run build", { cwd: REPO_ROOT, stdio: "ignore" });
});

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("#1165 — CLI entry loads .env via process.loadEnvFile()", () => {
  it("(a) reads tokens from a .env in cwd when they are absent from the child env", () => {
    const dir = mkTempDir("with-env");
    writeFileSync(
      join(dir, ".env"),
      [
        "SLACK_BOT_TOKEN=xoxb-stub-1165",
        "SLACK_APP_TOKEN=xapp-stub-1165",
        "MONDAY_TEST_MODE=1",
        "ANTHROPIC_API_KEY=test-stub-key",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(dir, "config.yaml"), "watchedFolders: []\n", "utf8");

    // (G2) Build the child env by COPY + DELETE so SLACK_* are truly absent —
    // not set to the literal string "undefined" (which validateEnv treats as
    // present). The only source of tokens here is the temp .env.
    const childEnv = { ...process.env };
    delete childEnv.SLACK_BOT_TOKEN;
    delete childEnv.SLACK_APP_TOKEN;
    delete childEnv.MONDAY_TEST_MODE;

    const result = execFileSync(process.execPath, [DIST_ENTRY], {
      cwd: dir,
      env: childEnv,
      encoding: "utf8",
      timeout: 60_000,
    });

    // execFileSync only returns (no throw) on exit code 0. MONDAY_TEST_MODE=1
    // from the .env → fake Bolt app → ready-log → process.exit(0).
    // (G3) Assert on stdout only — pdfjs warns on stderr.
    expect(result).toContain(READY_LOG);
  });

  it("(b) a missing .env does not crash — guard swallows ENOENT, falls back to shell env", () => {
    const dir = mkTempDir("no-env");
    // config.yaml present, but NO .env file.
    writeFileSync(join(dir, "config.yaml"), "watchedFolders: []\n", "utf8");

    // Tokens passed DIRECTLY in the child env (the shell-exported fallback).
    const childEnv = {
      ...process.env,
      SLACK_BOT_TOKEN: "xoxb-stub-1165",
      SLACK_APP_TOKEN: "xapp-stub-1165",
      MONDAY_TEST_MODE: "1",
      ANTHROPIC_API_KEY: "test-stub-key",
    };

    const result = execFileSync(process.execPath, [DIST_ENTRY], {
      cwd: dir,
      env: childEnv,
      encoding: "utf8",
      timeout: 60_000,
    });

    // process.loadEnvFile() threw ENOENT, the guard swallowed it, and startup
    // fell back to the shell-passed tokens → ready-log + clean exit.
    expect(result).toContain(READY_LOG);
  });
});
