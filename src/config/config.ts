import * as fs from "fs";
import * as path from "path";

// Type-only import (erased at runtime — no service module loaded at config time).
import type { RecallConfig } from "../knowledge/service";

// Minimal local typing for js-yaml v3 — avoids depending on @types/js-yaml
// for a single function call.
interface YamlModule {
  load: (input: string) => unknown;
  YAMLException: new (...args: unknown[]) => Error;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml: YamlModule = require("js-yaml");

/**
 * Shape of the parsed config.yaml. Keys are optional at the type level so
 * partial configs don't fail the loader; downstream callers decide what's
 * required for their feature.
 */
export interface AppConfig {
  /** Filesystem root for vector index, embed cache, generated artefacts. */
  indexPath?: string;
  /** Top-level cron schedule for the primary sync loop. */
  confluenceSchedule?: string;
  /** Confluence sync settings (US-07). */
  confluence?: {
    schedule?: string;
    spaces?: string[];
    pageLimit?: number;
  };
  /** Jira sync settings (#1168). Projects/creds come from env, not here. */
  jira?: {
    schedule?: string;
  };
  /**
   * Recall v2 ranking levers (#1191). Threaded into KnowledgeService at the
   * production construction site (src/index.ts). Omitted → shipped defaults
   * (expansion ON, diversity cap ON, rerank OFF).
   */
  recall?: RecallConfig;
  /** Pass-through for forward-compatible keys we haven't typed yet. */
  [key: string]: unknown;
}

export class ConfigLoadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

const DEFAULT_CONFIG_FILENAME = "config.yaml";

/** Human-readable YAML-ish type name for error messages ("null", "array", ...). */
function typeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

/** Refuse a present-but-wrongly-typed key. Absent keys (undefined) pass. */
function requireString(
  value: unknown,
  keyPath: string,
  resolved: string
): void {
  if (value !== undefined && typeof value !== "string") {
    throw new ConfigLoadError(
      `Config key "${keyPath}" in ${resolved} must be a string, ` +
        `got ${typeName(value)}.`
    );
  }
}

function requireNumber(
  value: unknown,
  keyPath: string,
  resolved: string
): void {
  if (value !== undefined && typeof value !== "number") {
    throw new ConfigLoadError(
      `Config key "${keyPath}" in ${resolved} must be a number, ` +
        `got ${typeName(value)}.`
    );
  }
}

function requireMapping(
  value: unknown,
  keyPath: string,
  resolved: string
): void {
  if (
    value !== undefined &&
    (typeof value !== "object" ||
      value === null ||
      Array.isArray(value))
  ) {
    throw new ConfigLoadError(
      `Config key "${keyPath}" in ${resolved} must be a mapping ` +
        `(key: value pairs), got ${typeName(value)}.`
    );
  }
}

function requireStringArray(
  value: unknown,
  keyPath: string,
  resolved: string
): void {
  if (value === undefined) {
    return;
  }
  const offender =
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string");
  if (offender) {
    throw new ConfigLoadError(
      `Config key "${keyPath}" in ${resolved} must be an array of ` +
        `strings, got ${typeName(value)}${
          Array.isArray(value)
            ? ` containing a non-string entry (${typeName(
                value.find((entry) => typeof entry !== "string")
              )})`
            : ""
        }.`
    );
  }
}

/**
 * Validate the known keys of an already-parsed config mapping (#145).
 *
 * Hand-written checks — no schema dependency. Unknown keys, `recall`, and
 * absent keys are deliberately untouched (pass through unchanged) so partial
 * and forward-compatible configs keep loading. Only keys the loader claims
 * to understand are type-checked, so a wrongly-typed known key is refused
 * at load time with a message that names the key.
 */
function validateKnownKeys(
  cfg: Record<string, unknown>,
  resolved: string
): void {
  requireString(cfg.indexPath, "indexPath", resolved);
  requireString(cfg.confluenceSchedule, "confluenceSchedule", resolved);
  requireMapping(cfg.confluence, "confluence", resolved);
  requireMapping(cfg.jira, "jira", resolved);

  if (cfg.confluence !== undefined) {
    const confluence = cfg.confluence as Record<string, unknown>;
    requireString(confluence.schedule, "confluence.schedule", resolved);
    requireStringArray(confluence.spaces, "confluence.spaces", resolved);
    requireNumber(confluence.pageLimit, "confluence.pageLimit", resolved);
  }
  if (cfg.jira !== undefined) {
    const jira = cfg.jira as Record<string, unknown>;
    requireString(jira.schedule, "jira.schedule", resolved);
  }
}

/**
 * Read and parse `config.yaml` from the project root (or a provided path).
 *
 * Returns an empty object if the file is empty (a YAML doc of `null` or `{}`),
 * never undefined. Throws `ConfigLoadError` with a friendly message on a
 * missing file, YAML parse error, or a wrongly-typed known key (#145) —
 * matches the US-10 graceful-error precedent (no raw stack traces leaking
 * to the operator).
 */
export function loadConfig(configPath?: string): AppConfig {
  const resolved =
    configPath ?? path.resolve(process.cwd(), DEFAULT_CONFIG_FILENAME);

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigLoadError(
        `Config file not found at ${resolved}. ` +
          `Copy config.yaml from the repo root, or set CONFIG_PATH to point ` +
          `at your tuned copy.`,
        err
      );
    }
    throw new ConfigLoadError(
      `Failed to read config file at ${resolved}: ${(err as Error).message}`,
      err
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new ConfigLoadError(
      `Failed to parse YAML in ${resolved}: ${(err as Error).message}. ` +
        `Check for tab characters, mismatched indentation, or unquoted ` +
        `cron expressions.`,
      err
    );
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigLoadError(
      `Config root in ${resolved} must be a YAML mapping (key: value pairs), ` +
        `got ${Array.isArray(parsed) ? "array" : typeof parsed}.`
    );
  }

  const cfg = parsed as Record<string, unknown>;
  validateKnownKeys(cfg, resolved);
  return cfg as AppConfig;
}
