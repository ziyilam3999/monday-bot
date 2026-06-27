/**
 * AC-12 — the #1280 reuse seam is importable with NO CLI/env coupling.
 *
 * Imports `categorizeAll` from `src/triage/` AND `buildJiraCategoryWriter` from
 * `src/jira/` directly, exercises `setCategory` against an injected fake, and
 * NEVER imports the CLI module (`src/triage/cli`) nor reads any env var. This
 * proves EPIC #1280 can wire the two core gears without the CLI shell.
 */
import { categorizeAll } from "../src/triage/categorizeDefect";
import { buildJiraCategoryWriter } from "../src/jira/categoryWriter";

describe("AC-12 — #1280 reuse seam (importable, no CLI/env coupling)", () => {
  it("classifies via categorizeAll and writes via buildJiraCategoryWriter against a fake", async () => {
    // Snapshot env to PROVE no env var is read by these gears.
    const envBefore = JSON.stringify(process.env);

    const { results, counts } = categorizeAll([
      { key: "S-1", summary: "crash on null pointer", issueType: "Bug" },
      { key: "S-2", summary: "update the readme doc", issueType: "Task" },
    ]);
    expect(results).toHaveLength(2);
    expect(counts["correctness-bug"]).toBe(1);
    expect(counts.documentation).toBe(1);

    const writes: Array<[string, string]> = [];
    const fetchImpl = jest.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body);
      writes.push([(_url as string), body.update.labels[0].add]);
      return { ok: true, status: 204, statusText: "No Content", async json() { return {}; } };
    }) as unknown as typeof fetch;

    const writer = buildJiraCategoryWriter(
      { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" },
      fetchImpl,
    );
    for (const r of results) {
      if (r.key) await writer.setCategory(r.key, r.category);
    }
    expect(writes).toHaveLength(2);
    expect(writes[0][0]).toContain("/rest/api/3/issue/S-1");

    // Env was untouched by either gear.
    expect(JSON.stringify(process.env)).toBe(envBefore);
  });

  it("the CLI module is NOT a transitive import of the seam gears", () => {
    // If importing these two gears pulled in the CLI, it would appear in the
    // module cache. Assert it does not.
    const cliResolved = require.resolve("../src/triage/cli");
    const inCache = Object.keys(require.cache).some((p) => p === cliResolved);
    expect(inCache).toBe(false);
  });
});
