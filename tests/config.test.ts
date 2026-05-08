import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig, ConfigLoadError } from "../src/config/config";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monday-config-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a well-formed config.yaml into a typed object", () => {
    const file = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      file,
      [
        "watchedFolders:",
        "  - ./docs",
        "  - ./notes",
        "indexPath: ./tmp/index",
        'confluenceSchedule: "0 */6 * * *"',
      ].join("\n")
    );
    const cfg = loadConfig(file);
    expect(cfg.watchedFolders).toEqual(["./docs", "./notes"]);
    expect(cfg.indexPath).toBe("./tmp/index");
    expect(cfg.confluenceSchedule).toBe("0 */6 * * *");
  });

  it("returns {} for an empty file rather than throwing", () => {
    const file = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(file, "");
    expect(loadConfig(file)).toEqual({});
  });

  it("throws ConfigLoadError when the file is missing", () => {
    const file = path.join(tmpDir, "missing.yaml");
    expect(() => loadConfig(file)).toThrow(ConfigLoadError);
  });

  it("throws ConfigLoadError on YAML syntax errors", () => {
    const file = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(file, "watchedFolders:\n  - ./docs\n  badly:indented");
    expect(() => loadConfig(file)).toThrow(ConfigLoadError);
  });

  it("rejects a YAML root that is not a mapping", () => {
    const file = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(file, "- just\n- a\n- list\n");
    expect(() => loadConfig(file)).toThrow(ConfigLoadError);
  });
});
