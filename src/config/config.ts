import * as fs from "fs";
import * as path from "path";

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
  /** Local document folders the watcher ingests. Empty/undefined disables. */
  watchedFolders?: string[];
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

/**
 * Read and parse `config.yaml` from the project root (or a provided path).
 *
 * Returns an empty object if the file is empty (a YAML doc of `null` or `{}`),
 * never undefined. Throws `ConfigLoadError` with a friendly message on a
 * missing file or YAML parse error — matches the US-10 graceful-error
 * precedent (no raw stack traces leaking to the operator).
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

  return parsed as AppConfig;
}
