/**
 * #1167 — macOS launchd LaunchAgent assets.
 *
 * Validates the committed, PUBLIC-repo-safe artifacts:
 *   - deploy/launchd/com.monday-bot.plist.template
 *   - scripts/install-launchd.sh
 *
 * These checks are CONTENT-based (fs reads) so they run identically on the CI
 * ubuntu + windows matrix. The only subprocess — `bash -n` syntax check — is
 * guarded to skip on win32, mirroring tests/index.loadenv.test.ts's convention.
 * CI never runs `launchctl`; the install path is the operator's blessed step.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..");
const TEMPLATE = join(REPO_ROOT, "deploy", "launchd", "com.monday-bot.plist.template");
const SCRIPT = join(REPO_ROOT, "scripts", "install-launchd.sh");

const template = readFileSync(TEMPLATE, "utf8");
const script = readFileSync(SCRIPT, "utf8");

describe("launchd plist template", () => {
  it("declares all required LaunchAgent keys", () => {
    for (const key of [
      "Label",
      "ProgramArguments",
      "WorkingDirectory",
      "RunAtLoad",
      "KeepAlive",
      "StandardOutPath",
      "StandardErrorPath",
      "EnvironmentVariables",
    ]) {
      expect(template).toContain(`<key>${key}</key>`);
    }
  });

  it("uses the com.monday-bot label and KeepAlive/RunAtLoad true", () => {
    expect(template).toContain("<string>com.monday-bot</string>");
    // RunAtLoad + KeepAlive must be enabled (start at login, restart on crash).
    expect(template).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(template).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("carries every placeholder token the installer resolves", () => {
    for (const token of ["<REPO_DIR>", "<LOG_DIR>", "<PATH_VALUE>"]) {
      expect(template).toContain(token);
    }
    // PATH is set so node (resolved by the wrapper) works under launchd's minimal env.
    expect(template).toContain("<key>PATH</key>");
  });

  it("execs the build-on-start wrapper, NOT dist/index.js directly (#1348 Layer 3)", () => {
    // The wrapper path appears inside ProgramArguments.
    expect(template).toContain("<REPO_DIR>/scripts/launchd-wrapper.sh");
    // dist/index.js is no longer the direct entrypoint launchd runs.
    expect(template).not.toContain("<REPO_DIR>/dist/index.js");
  });

  it("leaks NO real machine paths (PUBLIC repo)", () => {
    // No real home dir, username, or absolute /Users path may be baked in.
    expect(template).not.toMatch(/\/Users\//);
    expect(template).not.toMatch(/\/home\/[a-z]/);
  });
});

describe("install-launchd.sh", () => {
  it("is strict-mode and fails loudly on missing ACTIVATION prerequisites", () => {
    expect(script).toContain("set -euo pipefail");
    // #1348 M4: the dist/index.js-exists install guard is GONE (the wrapper
    // builds dist on start), so it must NOT reappear as a hard precondition.
    expect(script).not.toMatch(/-f "\$\{REPO_DIR\}\/dist\/index\.js"/);
    expect(script).toContain(".env"); // .env still required to ACTIVATE
    expect(script).toMatch(/command -v node/); // node-path resolution (for PATH_VALUE)
  });

  it("splits render-safe prereqs from activation prereqs so --print-only never dies on missing .env/dist (#1348 M4)", () => {
    expect(script).toContain("resolve_render_prereqs");
    expect(script).toContain("resolve_activation_prereqs");
  });

  it("drives launchctl idempotently (bootout before bootstrap) and offers status/uninstall", () => {
    expect(script).toContain("launchctl bootout");
    expect(script).toContain("launchctl bootstrap");
    expect(script).toContain("launchctl enable");
    expect(script).toContain("launchctl kickstart");
    expect(script).toContain("launchctl print"); // status
  });

  it("does not bake in a real /Users path", () => {
    expect(script).not.toMatch(/\/Users\//);
  });

  // Syntax-only; bash isn't guaranteed on the Windows CI runner.
  const maybe = process.platform === "win32" ? it.skip : it;
  maybe("passes `bash -n` (syntax check)", () => {
    expect(() => execFileSync("bash", ["-n", SCRIPT], { stdio: "pipe" })).not.toThrow();
  });
});
