import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { VectorIndex } from "../src/index/vectorIndex";

jest.setTimeout(180_000);

describe("VectorIndex", () => {
  it("adds chunks and ranks the most relevant source first", async () => {
    const idx = new VectorIndex();
    await idx.add([
      {
        id: "c1",
        text: "The VPN requires Cisco AnyConnect installed on your laptop.",
        source: "vpn-guide.txt",
        heading: "VPN Setup",
      },
      {
        id: "c2",
        text: "Company holiday schedule is posted on the HR portal every December.",
        source: "hr-policy.txt",
        heading: "Holidays",
      },
    ]);
    const results = await idx.search("how to connect to VPN", 2);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toContain("vpn");
  });

  it("persists and reloads an index from disk without loss of fidelity", async () => {
    const dir = path.join(os.tmpdir(), `monday-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const a = new VectorIndex();
      await a.add([
        {
          id: "x1",
          text: "Refund requests must be submitted within 30 days.",
          source: "refund-policy.txt",
          heading: "Refunds",
        },
      ]);
      await a.save(dir);
      const b = new VectorIndex();
      await b.load(dir);
      const results = await b.search("refund deadline", 1);
      expect(results.length).toBe(1);
      expect(results[0].source).toContain("refund");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes a chunk so it no longer appears in search results", async () => {
    const idx = new VectorIndex();
    await idx.add([
      {
        id: "del1",
        text: "Password reset instructions: go to accounts portal.",
        source: "it-guide.txt",
        heading: "Passwords",
      },
      {
        id: "keep1",
        text: "Email signature should include your title and phone.",
        source: "comms-guide.txt",
        heading: "Email",
      },
    ]);
    await idx.remove("del1");
    const results = await idx.search("password reset", 5);
    expect(results.find((r) => r.id === "del1")).toBeUndefined();
  });

  it("returns an empty array when searching an empty index", async () => {
    const idx = new VectorIndex();
    const results = await idx.search("anything", 3);
    expect(results).toEqual([]);
  });

  it("auto-generates stable ids for chunks without an explicit id", async () => {
    const idx = new VectorIndex();
    await idx.add([
      { text: "hello world", source: "a.txt" },
      { text: "goodbye world", source: "b.txt" },
    ]);
    const results = await idx.search("hello", 2);
    expect(results.length).toBe(2);
    expect(results.every((r) => typeof r.id === "string" && r.id.length > 0)).toBe(true);
  });

  it("rejects loading an index whose model does not match", async () => {
    const dir = path.join(os.tmpdir(), `monday-idx-model-${Date.now()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "index.json"),
        JSON.stringify({ model: "Xenova/bogus-model", chunks: [], vectors: [] }),
        "utf-8",
      );
      const idx = new VectorIndex();
      await expect(idx.load(dir)).rejects.toThrow(/does not match/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
