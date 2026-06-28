import {
  buildJiraNamespacedLabelWriter,
  computeUnstampOps,
} from "../src/jira/namespacedLabelWriter";
import { runUnstamp, UnmatchedUnstampKeysError } from "../src/triage/backfill";
import type { JiraIssue } from "../src/jira/sync";

/**
 * #1342 — reversible UNSTAMP (remove ALL the bot's namespaced labels).
 *
 * SYNTHETIC fixtures ONLY: example.atlassian.net, DEMO-* keys, and invented
 * `mb-*` slugs. ZERO live mutation — every write goes through an injected fake
 * `fetchImpl` SPY (mirrors tests/jira.namespacedLabels.test.ts).
 */

const CONFIG = { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok" };

function okFetchSpy(): jest.Mock {
  return jest.fn(async () => ({
    ok: true,
    status: 204,
    statusText: "No Content",
    async json() {
      return {};
    },
  }));
}

/** Minimal synthetic open-defect with the given labels. */
function issue(key: string, labels?: string[]): JiraIssue {
  return { key, summary: "", descriptionText: "", commentTexts: [], labels };
}

describe("AC-2 — computeUnstampOps removes ONLY bot labels (human label survives)", () => {
  it("emits a remove for each of the three namespaces, never a human label", () => {
    const ops = computeUnstampOps(["mb-feature-x", "mb-flow-y", "mb-symptom-z", "keep-me"]);
    expect(ops).toContainEqual({ remove: "mb-feature-x" });
    expect(ops).toContainEqual({ remove: "mb-flow-y" });
    expect(ops).toContainEqual({ remove: "mb-symptom-z" });
    // Human/other label is provably untouched — never in the op list.
    expect(JSON.stringify(ops)).not.toContain("keep-me");
    expect(ops).toHaveLength(3);
  });

  it("returns an EMPTY op list when no bot labels are present", () => {
    expect(computeUnstampOps(["keep-me", "another-human-label"])).toEqual([]);
    expect(computeUnstampOps([])).toEqual([]);
  });

  // S2: TWO labels in a SINGLE-value namespace are BOTH removed (duplicate
  // cleanup — the exact reverse of the stamp path's "remove ALL stale single").
  it("removes BOTH labels in a single-value namespace (two mb-feature-*)", () => {
    const ops = computeUnstampOps(["mb-feature-x", "mb-feature-y", "keep-me"]);
    expect(ops).toContainEqual({ remove: "mb-feature-x" });
    expect(ops).toContainEqual({ remove: "mb-feature-y" });
    expect(ops).toHaveLength(2);
    expect(JSON.stringify(ops)).not.toContain("keep-me");
  });
});

describe("AC-3 — unstamp idempotency: no bot labels → no PUT → zero network", () => {
  it("returns false and calls the injected fetch spy 0 times on an already-clean issue", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);

    const didPut = await writer.unstampLabels("DEMO-1", ["keep-me", "another-human-label"]);
    expect(didPut).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });
});

describe("AC-4 — multi-namespace unstamp: all bot labels removed in ONE PUT", () => {
  it("removes feature + two flows + symptom in a single PUT, human label untouched", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);

    const didPut = await writer.unstampLabels("DEMO-3", [
      "mb-feature-x",
      "mb-flow-a",
      "mb-flow-b",
      "mb-symptom-crash-error",
      "keep-me",
    ]);
    expect(didPut).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe("https://example.atlassian.net/rest/api/3/issue/DEMO-3");
    expect(init.method).toBe("PUT");

    const ops = JSON.parse(init.body).update.labels as Array<{ add?: string; remove?: string }>;
    expect(ops).toContainEqual({ remove: "mb-feature-x" });
    expect(ops).toContainEqual({ remove: "mb-flow-a" });
    expect(ops).toContainEqual({ remove: "mb-flow-b" });
    expect(ops).toContainEqual({ remove: "mb-symptom-crash-error" });
    expect(ops).toHaveLength(4);
    expect(JSON.stringify(ops)).not.toContain("keep-me");
  });
});

describe("AC-5 (N1) — unstamp dry-run issues ZERO writes (spied writer, apply:false)", () => {
  it("constructs the writer WITH a spy, runs apply:false → spy called 0 times", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);

    const result = await runUnstamp({
      fetchOpenDefects: async () => [issue("DEMO-1", ["mb-feature-x", "mb-symptom-crash-error"])],
      writer,
      apply: false,
      log: () => undefined,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(result.removed).toBe(0);
    // Preview still reports the issue WOULD be peeled.
    expect(result.removable).toBe(1);
    expect(result.total).toBe(1);
  });
});

describe("AC-6 — --keys scoping: only the targeted issue receives a remove-PUT", () => {
  it("with keys:[DEMO-1] over two synthetic issues, only DEMO-1 is PUT", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);

    const result = await runUnstamp({
      fetchOpenDefects: async () => [
        issue("DEMO-1", ["mb-feature-x"]),
        issue("DEMO-2", ["mb-flow-y"]),
      ],
      writer,
      apply: true,
      keys: ["DEMO-1"],
      log: () => undefined,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://example.atlassian.net/rest/api/3/issue/DEMO-1",
    );
    expect(result.total).toBe(1);
    expect(result.removed).toBe(1);
  });

  it("runUnstamp over a fully clean set issues ZERO PUTs (idempotent sweep)", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);

    const result = await runUnstamp({
      fetchOpenDefects: async () => [issue("DEMO-1", ["keep-me"]), issue("DEMO-2")],
      writer,
      apply: true,
      log: () => undefined,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(0);
    expect(result.removed).toBe(0);
    expect(result.removable).toBe(0);
    expect(result.total).toBe(2);
  });
});

describe("S1 — unmatched --keys FAIL LOUD (no silent zero-touch success)", () => {
  it("throws UnmatchedUnstampKeysError and issues ZERO PUTs on a key not in the set", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);

    await expect(
      runUnstamp({
        fetchOpenDefects: async () => [issue("DEMO-1", ["mb-feature-x"])],
        writer,
        apply: true,
        keys: ["NOPE-1"],
        log: () => undefined,
      }),
    ).rejects.toThrow(UnmatchedUnstampKeysError);

    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("treats a wrong-CASE key as unmatched (exact match) — the typo-no-op trap", async () => {
    const fetchImpl = okFetchSpy();
    const writer = buildJiraNamespacedLabelWriter(CONFIG, fetchImpl as unknown as typeof fetch);

    await expect(
      runUnstamp({
        fetchOpenDefects: async () => [issue("DEMO-1", ["mb-feature-x"])],
        writer,
        apply: true,
        keys: ["demo-1"], // lowercase — would silently touch zero issues without S1.
        log: () => undefined,
      }),
    ).rejects.toThrow(UnmatchedUnstampKeysError);

    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("carries the COUNT only — never echoes the key value (privacy-safe error)", async () => {
    const err = new UnmatchedUnstampKeysError(2);
    expect(err.count).toBe(2);
    expect(err.message).toContain("2");
    expect(err.message).not.toContain("NOPE");
  });
});
