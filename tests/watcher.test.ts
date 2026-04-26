import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FolderWatcher } from "../src/watcher/folderWatcher";

jest.setTimeout(15_000);

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "monday-watcher-test-"));
}

function rmDirSync(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Builds a fake `fs.watch` replacement we can drive deterministically from tests.
 * The returned `emit(filename, event)` triggers the listener installed by the
 * watcher so we don't depend on real OS events landing in time.
 */
function makeFakeFsWatch(): {
  fakeWatch: typeof fs.watch;
  emit: (filename: string, event?: "rename" | "change") => void;
  closed: () => boolean;
} {
  let listener:
    | ((event: "rename" | "change", filename: string | Buffer | null) => void)
    | null = null;
  let isClosed = false;

  const fakeWatch = ((
    _dir: fs.PathLike,
    _opts: unknown,
    cb?: (event: "rename" | "change", filename: string | Buffer | null) => void,
  ) => {
    listener = cb ?? null;
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const handle = {
      close() {
        isClosed = true;
        listener = null;
      },
      on(event: string, fn: (...args: unknown[]) => void) {
        const arr = handlers.get(event) ?? [];
        arr.push(fn);
        handlers.set(event, arr);
        return handle;
      },
    };
    return handle as unknown as fs.FSWatcher;
  }) as unknown as typeof fs.watch;

  const emit = (filename: string, event: "rename" | "change" = "rename") => {
    if (listener) listener(event, filename);
  };
  const closed = () => isClosed;
  return { fakeWatch, emit, closed };
}

describe("FolderWatcher", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTempDir();
  });

  afterEach(() => {
    rmDirSync(dir);
  });

  it("calls onAdd when a new file appears (debounced trailing edge)", async () => {
    const onAdd = jest.fn();
    const onChange = jest.fn();
    const onUnlink = jest.fn();

    const { fakeWatch, emit } = makeFakeFsWatch();
    const existsSync = jest.fn().mockReturnValue(true); // file is "on disk"

    const w = new FolderWatcher(
      dir,
      { onAdd, onChange, onUnlink },
      { debounceMs: 20, watch: fakeWatch, existsSync },
    );
    w.start();

    emit("new-doc.txt");
    await new Promise((r) => setTimeout(r, 60));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0]).toContain("new-doc.txt");
    expect(onChange).not.toHaveBeenCalled();
    expect(onUnlink).not.toHaveBeenCalled();
    w.close();
  });

  it("debounces rapid burst events into a single dispatch", async () => {
    const onAdd = jest.fn();
    const { fakeWatch, emit } = makeFakeFsWatch();
    const existsSync = () => true;

    const w = new FolderWatcher(
      dir,
      { onAdd },
      { debounceMs: 30, watch: fakeWatch, existsSync },
    );
    w.start();

    emit("burst.txt");
    emit("burst.txt");
    emit("burst.txt", "change");
    emit("burst.txt");
    await new Promise((r) => setTimeout(r, 80));

    expect(onAdd).toHaveBeenCalledTimes(1);
    w.close();
  });

  it("calls onChange for a file that already existed at start time", async () => {
    // Seed the directory before starting the watcher so the file is "known".
    const seeded = path.join(dir, "seeded.txt");
    fs.writeFileSync(seeded, "old content", "utf-8");

    const onAdd = jest.fn();
    const onChange = jest.fn();
    const { fakeWatch, emit } = makeFakeFsWatch();
    const existsSync = () => true;

    const w = new FolderWatcher(
      dir,
      { onAdd, onChange },
      { debounceMs: 20, watch: fakeWatch, existsSync },
    );
    w.start();

    emit("seeded.txt", "change");
    await new Promise((r) => setTimeout(r, 60));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toContain("seeded.txt");
    expect(onAdd).not.toHaveBeenCalled();
    w.close();
  });

  it("calls onUnlink when a previously-known file disappears", async () => {
    // Seed so the watcher knows the file existed.
    const seeded = path.join(dir, "doomed.txt");
    fs.writeFileSync(seeded, "bye", "utf-8");

    const onAdd = jest.fn();
    const onUnlink = jest.fn();
    const { fakeWatch, emit } = makeFakeFsWatch();
    // Simulate the file being gone by the time the trailing edge fires.
    const existsSync = () => false;

    const w = new FolderWatcher(
      dir,
      { onAdd, onUnlink },
      { debounceMs: 20, watch: fakeWatch, existsSync },
    );
    w.start();

    emit("doomed.txt");
    await new Promise((r) => setTimeout(r, 60));

    expect(onUnlink).toHaveBeenCalledTimes(1);
    expect(onUnlink.mock.calls[0][0]).toContain("doomed.txt");
    expect(onAdd).not.toHaveBeenCalled();
    w.close();
  });

  it("ignores spurious events for paths that never existed and don't exist", async () => {
    const onAdd = jest.fn();
    const onUnlink = jest.fn();
    const { fakeWatch, emit } = makeFakeFsWatch();
    const existsSync = () => false;

    const w = new FolderWatcher(
      dir,
      { onAdd, onUnlink },
      { debounceMs: 20, watch: fakeWatch, existsSync },
    );
    w.start();

    emit("ghost.txt");
    await new Promise((r) => setTimeout(r, 60));

    expect(onAdd).not.toHaveBeenCalled();
    expect(onUnlink).not.toHaveBeenCalled();
    w.close();
  });

  it("filters dotfiles and editor swap files by default", async () => {
    const onAdd = jest.fn();
    const { fakeWatch, emit } = makeFakeFsWatch();
    const existsSync = () => true;

    const w = new FolderWatcher(
      dir,
      { onAdd },
      { debounceMs: 20, watch: fakeWatch, existsSync },
    );
    w.start();

    emit(".hidden");
    emit("doc.swp");
    emit("backup~");
    await new Promise((r) => setTimeout(r, 60));

    expect(onAdd).not.toHaveBeenCalled();
    w.close();
  });

  it("isAlive() reflects start/close state", () => {
    const { fakeWatch } = makeFakeFsWatch();
    const w = new FolderWatcher(dir, {}, { watch: fakeWatch });
    expect(w.isAlive()).toBe(false);
    w.start();
    expect(w.isAlive()).toBe(true);
    w.close();
    expect(w.isAlive()).toBe(false);
  });

  it("close() is idempotent and refuses restart", () => {
    const { fakeWatch } = makeFakeFsWatch();
    const w = new FolderWatcher(dir, {}, { watch: fakeWatch });
    w.start();
    w.close();
    w.close(); // should not throw
    expect(() => w.start()).toThrow(/closed/i);
  });

  it("rejects empty dir argument", () => {
    expect(() => new FolderWatcher("", {})).toThrow(TypeError);
  });

  it("forwards onError when the underlying watcher emits an error event", () => {
    let errorHandler: ((e: Error) => void) | null = null;
    const fakeWatch = ((
      _d: fs.PathLike,
      _opts: unknown,
      _cb?: (...a: unknown[]) => void,
    ) => {
      const handle = {
        close() {},
        on(event: string, fn: (e: Error) => void) {
          if (event === "error") errorHandler = fn;
          return handle;
        },
      };
      return handle as unknown as fs.FSWatcher;
    }) as unknown as typeof fs.watch;

    const onError = jest.fn();
    const w = new FolderWatcher(dir, { onError }, { watch: fakeWatch });
    w.start();
    expect(errorHandler).not.toBeNull();
    errorHandler!(new Error("boom"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe("boom");
    w.close();
  });
});

describe("FolderWatcher integration with KnowledgeService", () => {
  it("KnowledgeService.watchFolder reports watcherAlive and indexes added files", async () => {
    const { KnowledgeService } = await import("../src/knowledge/service");

    const ingestCalls: string[] = [];
    const ingest = jest.fn(async (p: string) => {
      ingestCalls.push(p);
      return [{ text: `chunk for ${p}`, source: p }];
    });

    let triggerAdd: ((p: string) => Promise<void>) | null = null;
    const fakeWatcher = {
      start: jest.fn(),
      close: jest.fn(),
      isAlive: jest.fn().mockReturnValue(true),
    };
    const watcherFactory = jest.fn((_dir, callbacks) => {
      triggerAdd = callbacks.onAdd;
      return fakeWatcher;
    });

    const svc = new KnowledgeService({ ingest, watcherFactory });
    expect(svc.getStatus().watcherAlive).toBe(false);

    svc.watchFolder("/tmp/whatever");

    expect(fakeWatcher.start).toHaveBeenCalledTimes(1);
    expect(svc.getStatus().watcherAlive).toBe(true);

    await triggerAdd!("/tmp/whatever/new.txt");
    expect(ingest).toHaveBeenCalledWith("/tmp/whatever/new.txt");
    expect(svc.getStatus().documentCount).toBe(1);

    svc.stopWatching();
    fakeWatcher.isAlive.mockReturnValue(false);
    expect(svc.getStatus().watcherAlive).toBe(false);
  });

  it("onUnlink removes the file's chunks from the index", async () => {
    const { KnowledgeService } = await import("../src/knowledge/service");
    const { VectorIndex } = await import("../src/index/vectorIndex");

    const filePath = path.resolve("/tmp/some/policy.txt");
    const ingest = jest.fn(async (p: string) => [{ text: "policy body", source: p }]);

    const index = new VectorIndex();
    let triggerUnlink: ((p: string) => Promise<void>) | null = null;
    const fakeWatcher = {
      start: jest.fn(),
      close: jest.fn(),
      isAlive: jest.fn().mockReturnValue(true),
    };
    const watcherFactory = jest.fn((_dir, callbacks) => {
      triggerUnlink = callbacks.onUnlink;
      return fakeWatcher;
    });

    const svc = new KnowledgeService({ index, ingest, watcherFactory });
    await svc.indexFile(filePath);
    expect(index.size()).toBe(1);
    expect(svc.getStatus().documentCount).toBe(1);

    svc.watchFolder("/tmp/some");
    await triggerUnlink!(filePath);

    expect(index.size()).toBe(0);
    expect(svc.getStatus().documentCount).toBe(0);
  });

  it("onChange re-indexes a file (drops old chunks, adds new ones)", async () => {
    const { KnowledgeService } = await import("../src/knowledge/service");
    const { VectorIndex } = await import("../src/index/vectorIndex");

    const filePath = path.resolve("/tmp/some/changing.txt");
    let version = 1;
    const ingest = jest.fn(async (p: string) => [
      { text: `v${version} body`, source: p },
    ]);

    const index = new VectorIndex();
    let triggerChange: ((p: string) => Promise<void>) | null = null;
    const fakeWatcher = {
      start: jest.fn(),
      close: jest.fn(),
      isAlive: jest.fn().mockReturnValue(true),
    };
    const watcherFactory = jest.fn((_dir, callbacks) => {
      triggerChange = callbacks.onChange;
      return fakeWatcher;
    });

    const svc = new KnowledgeService({ index, ingest, watcherFactory });
    await svc.indexFile(filePath);
    expect(index.size()).toBe(1);

    svc.watchFolder("/tmp/some");
    version = 2;
    await triggerChange!(filePath);

    // Still only one chunk for this source, but it's the new content.
    expect(index.size()).toBe(1);
    expect(svc.getStatus().documentCount).toBe(1);
    // Two ingest calls total: initial + onChange re-index.
    expect(ingest).toHaveBeenCalledTimes(2);
  });
});
