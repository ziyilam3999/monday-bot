/**
 * Tests for src/slack/queryHandler.ts (US-10 — graceful error handling).
 *
 * These tests pin the contract enforced by AC-01:
 *   - handleQuery NEVER throws / rejects; on success it returns a Slack-postable
 *     `{ text, blocks }` payload, on failure a friendly fallback `{ text }`.
 *   - The friendly fallback NEVER contains stack-trace tokens (`Error:`,
 *     `at Object`, `stack`).
 *   - The friendly fallback DOES contain at least one of the human-readable
 *     hints (`sorry`, `unavailable`, `error`, `trouble`).
 *
 * They also cover the happy path: the answer text from the underlying
 * KnowledgeService is propagated through the formatter into the Slack payload.
 */
import { handleQuery, QueryService } from "../src/slack/queryHandler";

function fakeOk(): QueryService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(question: string) {
      calls.push(question);
      return {
        answer: `Annual leave is 14 days [1].`,
        citations: [{ num: 1, source: "hr-policy.md", heading: "Leave" }],
      };
    },
  };
}

function fakeReject(message: string): QueryService {
  return {
    async query() {
      throw new Error(message);
    },
  };
}

function fakeRejectNonError(payload: unknown): QueryService {
  return {
    async query() {
      // Reject with a non-Error to exercise the `String(err)` branch.
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw payload;
    },
  };
}

describe("slack/queryHandler — happy path", () => {
  // Silence the operator-stderr line during tests; we still assert nothing
  // leaks into the user-facing text.
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("returns the formatted answer text when the service resolves", async () => {
    const svc = fakeOk();
    const result = await handleQuery("how many days of leave?", svc);
    expect(svc.calls).toEqual(["how many days of leave?"]);
    expect(typeof result.text).toBe("string");
    expect(result.text).toContain("Annual leave is 14 days");
    // The formatter attaches blocks for citations on the success path.
    expect(Array.isArray(result.blocks)).toBe(true);
    expect((result.blocks ?? []).length).toBeGreaterThan(0);
  });
});

describe("slack/queryHandler — graceful error handling (US-10 AC-01)", () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("never throws when the service rejects — returns a friendly text payload", async () => {
    const svc = fakeReject("LLM connection refused at localhost:11434");
    const result = await handleQuery("anything", svc);
    expect(result).toBeDefined();
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("strips stack-trace tokens from the user-facing text", async () => {
    const svc = fakeReject(
      "ECONNREFUSED 127.0.0.1:11434\n    at Object.<anonymous> (/app/dist/foo.js:10:5)",
    );
    const result = await handleQuery("anything", svc);
    // Must not leak the canonical error-prefix, the V8 frame marker, or the
    // literal token "stack".
    expect(result.text).not.toContain("Error:");
    expect(result.text).not.toContain("at Object");
    expect(result.text).not.toContain("stack");
  });

  it("includes a human-readable hint (sorry / unavailable / error / trouble)", async () => {
    const svc = fakeReject("anything");
    const result = await handleQuery("anything", svc);
    const lower = result.text.toLowerCase();
    const hasHint =
      lower.includes("sorry") ||
      lower.includes("unavailable") ||
      lower.includes("error") ||
      lower.includes("trouble");
    expect(hasHint).toBe(true);
  });

  it("logs the underlying detail to stderr for operators", async () => {
    const svc = fakeReject("vector index corrupted");
    await handleQuery("anything", svc);
    expect(errSpy).toHaveBeenCalled();
    const firstCallArgs = errSpy.mock.calls[0].join(" ");
    expect(firstCallArgs).toContain("vector index corrupted");
  });

  it("handles non-Error rejections (string / object) without crashing", async () => {
    const svcStr = fakeRejectNonError("plain string failure");
    const r1 = await handleQuery("q", svcStr);
    expect(r1.text.toLowerCase()).toMatch(/sorry|trouble|error|unavailable/);

    const svcObj = fakeRejectNonError({ code: 503 });
    const r2 = await handleQuery("q", svcObj);
    expect(r2.text.toLowerCase()).toMatch(/sorry|trouble|error|unavailable/);
  });
});
