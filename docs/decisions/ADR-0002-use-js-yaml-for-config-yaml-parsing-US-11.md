---
adr: 2
status: "Accepted"
story: "US-11"
date: "2026-05-08"
title: "Use js-yaml for config.yaml parsing"
---

# ADR-0002: Use js-yaml for config.yaml parsing

## Context

US-11 introduces a hand-editable config.yaml at the repo root with
watchedFolders, indexPath, and confluenceSchedule keys. We need a YAML
parser to load it into a typed object at startup. The Node standard
library has no YAML support; the choice is which parser to depend on.

## Decision

Add js-yaml@^3.14.2 as a direct dependency in package.json. js-yaml is
the de-facto YAML parser in the Node ecosystem (used by webpack, eslint,
and most major tools), is already present transitively via existing
dev tooling, has zero runtime dependencies of its own, and exposes a
simple yaml.load(string) entrypoint that fits the loadConfig contract.
We pin to ^3.14.2 (matches the version already resolved in
package-lock.json) to avoid a fresh resolution churn.

## Consequences

Pros: tiny surface, well-known, no new transitive footprint, sync API
fits a startup-time loader without async ceremony. Cons: js-yaml v3 is
the legacy line (v4 exists with a slightly different API); if we later
want JSON-Schema validation or YAML 1.2 features we may need to migrate
to v4 or to ajv-yaml. That migration is local to src/config/config.ts
and one package.json line.

## Alternatives considered

- yaml (eemeli/yaml): more modern, supports YAML 1.2 fully, larger API
  surface. Rejected because we don't need 1.2-only features today and
  the bundle weight is higher.
- Hand-roll a minimal parser: rejected — config.yaml will grow, and a
  bespoke parser is a maintenance trap.
- Switch config to JSON: rejected — the brief explicitly calls for a
  "human-readable" config; YAML's comment support is the point.
