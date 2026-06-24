---
adr: 1
status: "Accepted"
story: "US-08"
date: "2026-04-27"
title: "Adopt @slack/bolt with Socket Mode for the Slack adapter"
---

# ADR-0001: Adopt @slack/bolt with Socket Mode for the Slack adapter

## Context

US-08 introduces the Slack-facing surface of monday-bot — handling @mention
events and the /ask slash command, and posting Block Kit replies that include
the answer text and per-citation source lines. We need a Slack SDK that
(a) supports Socket Mode so the bot needs no public HTTP ingress (laptop / dev
containers can connect outbound only), (b) exposes typed event and command
handlers with sane middleware semantics, and (c) is officially supported by
Slack so we inherit ongoing breaking-API mitigations.

## Decision

Add `@slack/bolt` (v4.x) as a runtime dependency and wire the adapter to use
Socket Mode (`socketMode: true`, `appToken: <xapp-...>`). The adapter
registers `app_mention` and `/ask` handlers in its constructor, validates
that `botToken`, `appToken`, and `knowledgeService` are provided (throwing a
`SlackConfigError` otherwise), and queries the injected knowledge service —
not a hard import — so the platform-agnostic boundary in
`src/knowledge/service.ts` is preserved (verified by AC-02: requiring the
service module does not pull `@slack/bolt` or `@slack/web-api` into
`require.cache`).

## Consequences

+ Bundle gains `@slack/bolt` + transitive `@slack/web-api`, `@slack/socket-mode`,
  `axios`, etc. (~110 packages). Acceptable for a server-side bot.
+ Socket Mode means we never expose a public URL — fits laptop-only and
  forge-harness sandbox deployment.
+ Bolt's `App` constructor handles auth, retries, and event routing; we keep
  the adapter thin.
- Bolt v4 is ESM-leaning but ships CommonJS-compatible builds; we keep the
  project on `"type": "commonjs"`. If we later move to ESM we'll need a
  review. Not a US-08 blocker.
- Bolt's surface is large; we deliberately type handler args as `any` inside
  the adapter to avoid leaking the full type surface into our public API.
- 4 high / 4 critical npm audit advisories surfaced from transitive deps
  (sub-deps of axios / form-data); follow up with `npm audit` review in a
  separate slice (out of scope for US-08 functional ACs).

## Alternatives considered

- `@slack/web-api` alone + a hand-rolled Socket Mode client: rejected — we'd
  reimplement event routing, ack semantics, and reconnect logic that Bolt
  already gets right.
- HTTP Receiver (default Bolt): rejected — requires public ingress (ngrok,
  a real domain, or a tunnel). Socket Mode keeps the deploy story simple.
- Slack's older `node-slack-client`: deprecated; rejected.
