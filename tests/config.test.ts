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
        "indexPath: ./tmp/index",
        'confluenceSchedule: "0 */6 * * *"',
      ].join("\n")
    );
    const cfg = loadConfig(file);
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
    fs.writeFileSync(file, "indexPath:\n  - ./docs\n  badly:indented");
    expect(() => loadConfig(file)).toThrow(ConfigLoadError);
  });

  it("rejects a YAML root that is not a mapping", () => {
    const file = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(file, "- just\n- a\n- list\n");
    expect(() => loadConfig(file)).toThrow(ConfigLoadError);
  });

  it("round-trips confluence subsection fields without mutation", () => {
    const file = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(
      file,
      [
        "confluence:",
        '  schedule: "0 */6 * * *"',
        "  spaces:",
        "    - ENG",
        "    - HR",
        "  pageLimit: 200",
      ].join("\n")
    );
    const cfg = loadConfig(file);
    expect(cfg.confluence?.schedule).toBe("0 */6 * * *");
    expect(cfg.confluence?.spaces).toEqual(["ENG", "HR"]);
    expect(cfg.confluence?.pageLimit).toBe(200);
  });

  describe("known-key type validation (#145)", () => {
    const writeConfig = (lines: string[]): string => {
      const file = path.join(tmpDir, "config.yaml");
      fs.writeFileSync(file, lines.join("\n"));
      return file;
    };

    const expectRefusal = (file: string, keyPath: RegExp): void => {
      expect(() => loadConfig(file)).toThrow(ConfigLoadError);
      expect(() => loadConfig(file)).toThrow(keyPath);
    };

    it("refuses indexPath that is not a string", () => {
      const file = writeConfig(["indexPath: 123"]);
      expectRefusal(file, /indexPath/);
    });

    it("refuses a null indexPath (empty YAML value)", () => {
      const file = writeConfig(["indexPath:"]);
      expectRefusal(file, /indexPath/);
    });

    it("refuses confluenceSchedule that is not a string", () => {
      const file = writeConfig(["confluenceSchedule: 42"]);
      expectRefusal(file, /confluenceSchedule/);
    });

    it("refuses confluence that is not a mapping", () => {
      const file = writeConfig(["confluence: nope"]);
      expectRefusal(file, /confluence/);
    });

    it("refuses confluence given as an array", () => {
      const file = writeConfig(["confluence:", "  - a", "  - b"]);
      expectRefusal(file, /confluence/);
    });

    it("refuses jira that is not a mapping", () => {
      const file = writeConfig(["jira: 7"]);
      expectRefusal(file, /jira/);
    });

    it("refuses confluence.schedule that is not a string", () => {
      const file = writeConfig(["confluence:", "  schedule: 5"]);
      expectRefusal(file, /confluence\.schedule/);
    });

    it("refuses jira.schedule that is not a string", () => {
      const file = writeConfig(["jira:", "  schedule: [daily]"]);
      expectRefusal(file, /jira\.schedule/);
    });

    it("refuses confluence.spaces that is not an array", () => {
      const file = writeConfig(["confluence:", "  spaces: ENG"]);
      expectRefusal(file, /confluence\.spaces/);
    });

    it("refuses confluence.spaces containing a non-string entry", () => {
      const file = writeConfig(["confluence:", "  spaces:", "    - ENG", "    - 5"]);
      expectRefusal(file, /confluence\.spaces/);
    });

    it("refuses confluence.pageLimit that is not a number", () => {
      const file = writeConfig(['confluence:', '  pageLimit: "100"']);
      expectRefusal(file, /confluence\.pageLimit/);
    });

    it("refuses a boolean confluence.pageLimit", () => {
      const file = writeConfig(["confluence:", "  pageLimit: true"]);
      expectRefusal(file, /confluence\.pageLimit/);
    });

    it("keeps loading the repo's own config.yaml unchanged", () => {
      const repoConfig = path.join(__dirname, "..", "config.yaml");
      const cfg = loadConfig(repoConfig);
      expect(cfg.indexPath).toBe("./tmp/index");
      expect(cfg.confluence?.pageLimit).toBe(100);
      expect(cfg.confluence?.schedule).toBe("0 */6 * * *");
      expect(cfg.jira?.schedule).toBe("0 */6 * * *");
    });

    it("passes unknown extra keys and recall through unchanged", () => {
      const file = writeConfig([
        "indexPath: ./tmp/index",
        "futureFeature:",
        "  nested: true",
        "recall:",
        "  queryExpansion:",
        "    enabled: false",
      ]);
      const cfg = loadConfig(file);
      expect(cfg.indexPath).toBe("./tmp/index");
      expect(cfg.futureFeature).toEqual({ nested: true });
      expect(cfg.recall).toEqual({ queryExpansion: { enabled: false } });
    });

    it("passes a config with only missing optional keys through untouched", () => {
      const file = writeConfig(["confluenceSchedule: \"0 0 * * *\""]);
      const cfg = loadConfig(file);
      expect(cfg).toEqual({ confluenceSchedule: "0 0 * * *" });
      expect(cfg.confluence).toBeUndefined();
      expect("indexPath" in cfg).toBe(false);
    });
  });
});
