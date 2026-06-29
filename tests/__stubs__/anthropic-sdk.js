// Test-only fake of @anthropic-ai/sdk — deterministic message builder.
// Wired in via jest.config.js moduleNameMapper. Real SDK calls happen in the
// US-04 inline AC commands (AC-01..AC-04), not in jest specs.

// #1195: record the most recent messages.create request so a determinism-wiring
// test can assert the caller passes `temperature: 0` (the request never escapes
// generateAnswer's return value, so we surface it on the module instead).
let __lastRequest = null;

// #1374b test infra: a FIFO response queue + call counter so the backstop's
// two-call regenerate path is testable. When the queue is empty, messages.create
// falls back to the canonical answer below (existing tests unchanged).
let __responseQueue = [];
let __callCount = 0;

class Anthropic {
  constructor(options) {
    this._options = options || {};
    if (!options || (!options.apiKey && !options.authToken)) {
      throw new Error("Anthropic SDK stub: neither apiKey nor authToken passed");
    }
    const self = this;
    this.messages = {
      async create(_req) {
        if (!_req || typeof _req !== "object") {
          throw new Error("Anthropic SDK stub: messages.create requires a request object");
        }
        __lastRequest = _req;
        __callCount += 1;
        if (typeof _req.model !== "string" || _req.model.length === 0) {
          throw new Error("Anthropic SDK stub: _req.model must be a non-empty string");
        }
        if (typeof _req.max_tokens !== "number" || _req.max_tokens <= 0) {
          throw new Error("Anthropic SDK stub: _req.max_tokens must be a positive number");
        }
        if (!Array.isArray(_req.messages) || _req.messages.length === 0) {
          throw new Error("Anthropic SDK stub: _req.messages must be a non-empty array");
        }
        for (let i = 0; i < _req.messages.length; i++) {
          const m = _req.messages[i];
          if (!m || typeof m !== "object") {
            throw new Error("Anthropic SDK stub: _req.messages[" + i + "] must be an object");
          }
          if (typeof m.role !== "string" || m.role.length === 0) {
            throw new Error("Anthropic SDK stub: _req.messages[" + i + "].role must be a non-empty string");
          }
          if (m.content === undefined || m.content === null) {
            throw new Error("Anthropic SDK stub: _req.messages[" + i + "].content is required");
          }
        }
        // #1374b: a queued response (FIFO) takes precedence so backstop tests
        // can script the two-call regenerate path. Empty queue -> canonical
        // answer below (existing tests unchanged). [1] keeps AC-01 happy; the
        // word count keeps AC-04 happy if a real call somehow hits the stub.
        const text =
          __responseQueue.length > 0
            ? __responseQueue.shift()
            : "Per the provided context, the documented procedure is to follow the " +
              "cited source material directly [1]. The context supplies a complete, " +
              "self-contained answer with no outside knowledge required.";
        return {
          id: "msg_stub_001",
          type: "message",
          role: "assistant",
          model: (_req && _req.model) || "claude-haiku-stub",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 42, output_tokens: 42 },
          _capturedRequest: _req,
          _auth: self._options,
        };
      },
    };
  }
}

// #1195 test introspection: the most recent messages.create request.
Anthropic.__getLastRequest = () => __lastRequest;
Anthropic.__resetLastRequest = () => {
  __lastRequest = null;
};

// #1374b test infra: controllable response queue + call counter.
Anthropic.__enqueueResponse = (text) => {
  __responseQueue.push(text);
};
Anthropic.__setResponses = (texts) => {
  __responseQueue = Array.isArray(texts) ? [...texts] : [];
};
Anthropic.__getCallCount = () => __callCount;
// __reset() clears the FIFO queue, the call counter, AND __lastRequest
// (__resetLastRequest semantics folded in) — see plan R3 leak-prevention.
Anthropic.__reset = () => {
  __responseQueue = [];
  __callCount = 0;
  __lastRequest = null;
};

module.exports = Anthropic;
module.exports.default = Anthropic;
module.exports.Anthropic = Anthropic;
