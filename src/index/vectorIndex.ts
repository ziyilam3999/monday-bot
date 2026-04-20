import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

import { embed, EMBEDDING_MODEL } from "../embeddings/embed";

export interface Chunk {
  id?: string;
  text: string;
  source: string;
  heading?: string;
  section?: string;
}

export interface SearchResult extends Chunk {
  id: string;
  score: number;
}

interface IndexFile {
  model: string;
  chunks: Array<Chunk & { id: string }>;
  vectors: number[][];
}

function autoId(chunk: Chunk): string {
  const hash = crypto.createHash("sha1");
  hash.update(chunk.source);
  hash.update("\n");
  hash.update(chunk.text);
  return hash.digest("hex").slice(0, 16);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

export class VectorIndex {
  private chunks: Array<Chunk & { id: string }> = [];
  private vectors: number[][] = [];

  async add(chunks: Chunk[]): Promise<void> {
    for (const c of chunks) {
      if (!c || typeof c.text !== "string" || typeof c.source !== "string") {
        throw new TypeError("VectorIndex.add: each chunk must have text and source");
      }
      const id = c.id ?? autoId(c);
      if (this.chunks.some((existing) => existing.id === id)) continue;
      const vec = await embed(c.text);
      this.chunks.push({ ...c, id });
      this.vectors.push(vec);
    }
  }

  async search(query: string, k: number): Promise<SearchResult[]> {
    if (this.chunks.length === 0) return [];
    const qvec = await embed(query);
    const scored = this.chunks.map((c, i) => ({
      ...c,
      score: cosine(qvec, this.vectors[i]),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, k));
  }

  async remove(id: string): Promise<void> {
    const idx = this.chunks.findIndex((c) => c.id === id);
    if (idx === -1) return;
    this.chunks.splice(idx, 1);
    this.vectors.splice(idx, 1);
  }

  async save(dir: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    const payload: IndexFile = {
      model: EMBEDDING_MODEL,
      chunks: this.chunks,
      vectors: this.vectors,
    };
    const target = path.join(dir, "index.json");
    fs.writeFileSync(target, JSON.stringify(payload), "utf-8");
  }

  async load(dir: string): Promise<void> {
    const target = path.join(dir, "index.json");
    const raw = fs.readFileSync(target, "utf-8");
    const parsed = JSON.parse(raw) as IndexFile;
    if (parsed.model && parsed.model !== EMBEDDING_MODEL) {
      throw new Error(
        `VectorIndex.load: index model "${parsed.model}" does not match loaded model "${EMBEDDING_MODEL}"`,
      );
    }
    this.chunks = parsed.chunks ?? [];
    this.vectors = parsed.vectors ?? [];
  }

  size(): number {
    return this.chunks.length;
  }
}
