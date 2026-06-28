import { formatJqlReply, jqlCommand, AdminService } from "../src/slack/commands";

/**
 * #1332 Stage C / AC14 — Slack `/jql` reply is JQL-FIRST, then results (option A).
 * ZERO network: the search is stubbed via a fake `answerJql`.
 */

const JQL = 'labels in ("mb-symptom-crash-error") AND statusCategory != Done';

describe("AC14 — formatJqlReply prints the JQL strictly before the first issue key", () => {
  it("the JQL substring index < the first matched issue key index", () => {
    const reply = formatJqlReply({
      jql: JQL,
      issues: [
        { key: "DEMO-1", summary: "checkout boom" },
        { key: "DEMO-2", summary: "another crash" },
      ],
    });
    const jqlIndex = reply.indexOf(JQL);
    const firstKeyIndex = reply.indexOf("DEMO-1");
    expect(jqlIndex).toBeGreaterThanOrEqual(0);
    expect(firstKeyIndex).toBeGreaterThanOrEqual(0);
    expect(jqlIndex).toBeLessThan(firstKeyIndex);
  });

  it("handles the no-results case without an issue key", () => {
    const reply = formatJqlReply({ jql: JQL, issues: [] });
    expect(reply).toContain(JQL);
    expect(reply).toMatch(/No matching defects/i);
  });

  it("trails warnings AFTER the JQL and results", () => {
    const reply = formatJqlReply({
      jql: JQL,
      issues: [{ key: "DEMO-1" }],
      warnings: ["feature labels not yet populated — this clause matches nothing until the deferred matcher runs."],
    });
    expect(reply.indexOf(JQL)).toBeLessThan(reply.indexOf("DEMO-1"));
    expect(reply.indexOf("DEMO-1")).toBeLessThan(reply.indexOf("not yet populated"));
  });
});

describe("jqlCommand handler (auto-run, read-only)", () => {
  it("formats JQL-first via a stubbed answerJql", async () => {
    const service: AdminService = {
      async answerJql() {
        return { jql: JQL, issues: [{ key: "DEMO-7", summary: "stub" }] };
      },
    };
    const reply = await jqlCommand(service, "show me crashes");
    expect(reply.indexOf(JQL)).toBeLessThan(reply.indexOf("DEMO-7"));
  });

  it("usage hint on empty question", async () => {
    const reply = await jqlCommand({}, "   ");
    expect(reply).toMatch(/Usage:/i);
  });

  it("degrades to not-configured when answerJql is absent", async () => {
    const reply = await jqlCommand({}, "show me crashes");
    expect(reply).toMatch(/not configured/i);
  });
});
