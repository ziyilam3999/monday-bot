/**
 * #1372 Part B — unit test for the blank-scope startup WARN seam
 * (warnIfDefectScopeUnset). Cross-platform, no launchctl, no subprocess. Uses an
 * injected sink so the message is asserted without capturing global console.
 *
 * Synthetic project keys ONLY — this is a PUBLIC repo and no real Jira project
 * key may appear in a committed test.
 */

import { warnIfDefectScopeUnset } from "../src/index";

function collect(env: NodeJS.ProcessEnv): string[] {
  const sink: string[] = [];
  warnIfDefectScopeUnset(env, (m) => sink.push(m));
  return sink;
}

describe("warnIfDefectScopeUnset (#1372 Part B / #1363)", () => {
  it("WARNS when JIRA_DEFAULT_PROJECTS is unset (AC-B1)", () => {
    expect(collect({})).toHaveLength(1);
  });

  it("WARNS when JIRA_DEFAULT_PROJECTS is blank or all-commas (AC-B1)", () => {
    expect(collect({ JIRA_DEFAULT_PROJECTS: "" })).toHaveLength(1);
    expect(collect({ JIRA_DEFAULT_PROJECTS: "   " })).toHaveLength(1);
    expect(collect({ JIRA_DEFAULT_PROJECTS: ", ,," })).toHaveLength(1);
  });

  it("is SILENT when set to a synthetic project key (AC-B2)", () => {
    expect(collect({ JIRA_DEFAULT_PROJECTS: "SAMPLEKEY" })).toHaveLength(0);
    expect(collect({ JIRA_DEFAULT_PROJECTS: "ALPHA,BETA" })).toHaveLength(0);
    expect(collect({ JIRA_DEFAULT_PROJECTS: " SOLO " })).toHaveLength(0);
  });

  it("the message carries the env-var name + #1363 but no project-key token (AC-B3)", () => {
    const msg = collect({})[0];
    expect(msg).toContain("JIRA_DEFAULT_PROJECTS");
    expect(msg).toContain("#1363");
    // No real/synthetic project key (e.g. ABC-123 / PROJ42) leaks into the text.
    expect(msg).not.toMatch(/\b[A-Z][A-Z0-9]+-\d+\b/);
    expect(msg).not.toMatch(/\bPROJ[A-Z]?\d*\b/);
  });

  it("does NOT throw when the env is unset (AC-B4 — no-throw contract)", () => {
    expect(() => warnIfDefectScopeUnset({}, () => undefined)).not.toThrow();
    // Also exercise the real default sink path (console.warn) without crashing.
    const original = console.warn;
    console.warn = () => undefined;
    try {
      expect(() => warnIfDefectScopeUnset({})).not.toThrow();
    } finally {
      console.warn = original;
    }
  });
});
