import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Folder watcher for the knowledge service. Wraps Node's `fs.watch` with a
 * debounced add/change/unlink callback API so the caller doesn't see the
 * burst of identical events that platforms emit on a single logical change.
 *
 * Cross-platform notes:
 *   - On Linux + Windows + macOS, `fs.watch` reports `'rename'` on add/unlink
 *     and `'change'` on modify. We disambiguate by stat'ing the path inside the
 *     debounce trailing-edge handler: file exists -> add-or-change, missing -> unlink.
 *   - We track the last "exists" state per path so a stat after debounce can decide
 *     between "added/changed" and "deleted" without races against a quick
 *     create-modify-delete sequence (the trailing edge wins, which is correct
 *     for our use case — the index only cares about the final on-disk state).
 *   - `{ recursive: true }` is supported on Linux/macOS/Windows in Node 20+.
 */

export type WatcherEvent = "add" | "change" | "unlink";

export interface FolderWatcherOptions {
  /** Debounce window in ms. Defaults to 200 ms. */
  debounceMs?: number;
  /** Optional file filter. Return false to ignore the path (e.g. dotfiles, swap files). */
  filter?: (absolutePath: string) => boolean;
  /** Injected for tests. Defaults to `fs.watch`. */
  watch?: typeof fs.watch;
  /** Injected for tests. Defaults to `fs.existsSync`. */
  existsSync?: (p: string) => boolean;
}

export interface FolderWatcherCallbacks {
  onAdd?: (absolutePath: string) => void | Promise<void>;
  onChange?: (absolutePath: string) => void | Promise<void>;
  onUnlink?: (absolutePath: string) => void | Promise<void>;
  /** Called when fs.watch itself errors. Optional; logged to stderr if absent. */
  onError?: (err: Error) => void;
}

const DEFAULT_DEBOUNCE_MS = 200;

function defaultFilter(absolutePath: string): boolean {
  const base = path.basename(absolutePath);
  // Skip dotfiles, editor swap files, and obvious tempfiles.
  if (base.startsWith(".")) return false;
  if (base.endsWith("~")) return false;
  if (base.endsWith(".swp") || base.endsWith(".swx")) return false;
  return true;
}

export class FolderWatcher {
  private readonly dir: string;
  private readonly debounceMs: number;
  private readonly filter: (absolutePath: string) => boolean;
  private readonly watchFn: typeof fs.watch;
  private readonly existsSyncFn: (p: string) => boolean;
  private readonly callbacks: FolderWatcherCallbacks;

  private watcher: fs.FSWatcher | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly known = new Set<string>();
  private closed = false;

  constructor(
    dir: string,
    callbacks: FolderWatcherCallbacks,
    opts: FolderWatcherOptions = {},
  ) {
    if (typeof dir !== "string" || dir.length === 0) {
      throw new TypeError("FolderWatcher: dir must be a non-empty string");
    }
    this.dir = path.resolve(dir);
    this.callbacks = callbacks;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.filter = opts.filter ?? defaultFilter;
    this.watchFn = opts.watch ?? fs.watch;
    this.existsSyncFn = opts.existsSync ?? fs.existsSync;
  }

  /**
   * Start watching the folder. Safe to call once per instance.
   * Throws if the underlying `fs.watch` call throws synchronously.
   */
  start(): void {
    if (this.watcher) return;
    if (this.closed) {
      throw new Error("FolderWatcher: cannot restart a closed watcher");
    }

    // Seed `known` with the current contents so the first events after start
    // can tell "already there" from "newly added".
    try {
      const entries = fs.readdirSync(this.dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile()) {
          this.known.add(path.join(this.dir, e.name));
        }
      }
    } catch {
      // dir might not exist yet; the watch call below will throw with a clearer message
    }

    this.watcher = this.watchFn(this.dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const absolutePath = path.isAbsolute(filename as string)
        ? (filename as string)
        : path.join(this.dir, filename as string);
      if (!this.filter(absolutePath)) return;
      this.scheduleDebounced(absolutePath);
    });

    this.watcher.on("error", (err) => {
      if (this.callbacks.onError) {
        this.callbacks.onError(err);
      } else {
        // eslint-disable-next-line no-console
        console.error("FolderWatcher error:", err);
      }
    });
  }

  /** Returns true if the watcher is currently active. */
  isAlive(): boolean {
    return this.watcher !== null && !this.closed;
  }

  /** Stop watching and release all timers. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore — close is best-effort
      }
      this.watcher = null;
    }
  }

  private scheduleDebounced(absolutePath: string): void {
    const existing = this.timers.get(absolutePath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(absolutePath);
      void this.dispatchTrailingEdge(absolutePath);
    }, this.debounceMs);
    // Don't keep the event loop alive solely for a debounce timer.
    if (typeof t.unref === "function") t.unref();
    this.timers.set(absolutePath, t);
  }

  private async dispatchTrailingEdge(absolutePath: string): Promise<void> {
    if (this.closed) return;
    const exists = this.existsSyncFn(absolutePath);
    const wasKnown = this.known.has(absolutePath);

    try {
      if (exists && !wasKnown) {
        this.known.add(absolutePath);
        if (this.callbacks.onAdd) await this.callbacks.onAdd(absolutePath);
      } else if (exists && wasKnown) {
        if (this.callbacks.onChange) await this.callbacks.onChange(absolutePath);
      } else if (!exists && wasKnown) {
        this.known.delete(absolutePath);
        if (this.callbacks.onUnlink) await this.callbacks.onUnlink(absolutePath);
      }
      // !exists && !wasKnown -> spurious event; ignore.
    } catch (err) {
      if (this.callbacks.onError) {
        this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      } else {
        // eslint-disable-next-line no-console
        console.error("FolderWatcher dispatch error:", err);
      }
    }
  }
}
