// Test-only fake of @slack/bolt — captures registered handlers and exposes a
// minimal trigger() helper for unit tests. Wired in via jest.config.js
// moduleNameMapper. No real Slack connection ever made.

class FakeApp {
  constructor(options) {
    this._options = options || {};
    this._eventHandlers = new Map();
    this._commandHandlers = new Map();
    this._started = false;
    this._stopped = false;
    this._postMessages = [];
    this._respondMessages = [];
    this._ackCalls = 0;

    if (!options || (typeof options.token !== "string" && typeof options.authorize !== "function")) {
      throw new Error("Slack Bolt stub: token or authorize must be provided");
    }
  }

  event(eventName, handler) {
    if (typeof eventName !== "string" || eventName.length === 0) {
      throw new Error("Slack Bolt stub: event name must be a non-empty string");
    }
    if (typeof handler !== "function") {
      throw new Error("Slack Bolt stub: event handler must be a function");
    }
    this._eventHandlers.set(eventName, handler);
  }

  command(name, handler) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Slack Bolt stub: command name must be a non-empty string");
    }
    if (typeof handler !== "function") {
      throw new Error("Slack Bolt stub: command handler must be a function");
    }
    this._commandHandlers.set(name, handler);
  }

  async start() {
    this._started = true;
  }

  async stop() {
    this._stopped = true;
  }

  // Test helpers — not part of the real Bolt API.
  async _triggerEvent(name, event) {
    const handler = this._eventHandlers.get(name);
    if (!handler) throw new Error("Slack Bolt stub: no handler for event " + name);
    const self = this;
    await handler({
      event,
      client: {
        chat: {
          postMessage: async (msg) => {
            self._postMessages.push(msg);
            return { ok: true };
          },
        },
      },
      logger: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
      say: async () => ({ ok: true }),
    });
  }

  async _triggerCommand(name, command) {
    const handler = this._commandHandlers.get(name);
    if (!handler) throw new Error("Slack Bolt stub: no handler for command " + name);
    const self = this;
    await handler({
      command,
      ack: async () => {
        self._ackCalls += 1;
      },
      respond: async (msg) => {
        self._respondMessages.push(msg);
        return { ok: true };
      },
      logger: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
    });
  }
}

const LogLevel = {
  ERROR: "error",
  WARN: "warn",
  INFO: "info",
  DEBUG: "debug",
};

module.exports = { App: FakeApp, LogLevel };
module.exports.App = FakeApp;
module.exports.LogLevel = LogLevel;
module.exports.default = { App: FakeApp, LogLevel };
