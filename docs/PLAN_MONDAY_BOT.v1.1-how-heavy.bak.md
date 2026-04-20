# Plan: Rewrite as TypeScript Headless Slack Bot — "Monday"

**Version**: 1.1.0
**Date**: 2026-03-10
**Status**: Draft — pending approval

### Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.1.0 | 2026-03-10 | RAG chunk size optimization (S20): chunk size 200→150 words, overlap 50→40 words, top-K 5→7, context window 4096→3072. Deep analysis of 5 chunk size options evaluated across 8 dimensions (token math, embedding quality, retrieval quality, LLM generation, speed, scalability, content-type fit, risks). Updated all config values, code examples, token budgets, speed presets, and migration notes to reflect new settings. Added Section 20 with full rationale. |
| 1.0.0 | 2026-03-09 | Initial comprehensive plan with 19 sections covering: model selection (Qwen3.5-2B), hosting strategy (Malaysia), headless architecture, TypeScript project structure, module mapping, Slack Bolt integration, RAG pipeline with section-aware chunking (S15), facts-only prompt (S18), 200-word answers (S16), hardware auto-detection (S17), GPU analysis (S19), and 5-phase implementation plan |

---

## Context

The user wants to evolve the AI File Search app from a local Python desktop tool into a **team-shared Slack AI assistant**. Rather than migrating the Python codebase incrementally, a **full rewrite in TypeScript** is the better approach because:

1. The UI layer (Flask + PyWebView + CLI) is being entirely dropped — Slack becomes the only interface
2. The dependency stack changes fundamentally (FAISS → hnswlib, sentence-transformers → Transformers.js, watchdog → chokidar)
3. Slack's Bolt SDK is TypeScript-first with better examples and support
4. A clean rewrite avoids carrying dead code and Python-specific patterns
5. Simpler deployment for team use (Node.js has fewer binary dependency issues than Python ML stacks)

The app will be called **"Monday"** — a friendly AI knowledge assistant that lives in Slack.

**New repo name**: `monday-bot`

---

## 1. Model Decision: Qwen3.5-2B

| Factor | Current (Qwen2.5-1.5B) | New (Qwen3.5-2B) |
|--------|------------------------|-------------------|
| RAM (Q4_K_M) | ~1 GB | ~1.5 GB |
| CPU tok/s (est.) | ~20-30 | ~25-35 |
| Intelligence Index | ~8 | **16** (2x) |
| Context window | 2,048 | 262,144 |

The app generates **200-word fact-based answers from retrieved chunks** (upgraded from 50 words — see Section 16). The 2B model's Intelligence Index of 16 is well-suited for extracting and summarizing facts. The 4B/9B would only matter if we later add reasoning or complex multi-document synthesis.

**GGUF file**: `unsloth/Qwen3.5-2B-GGUF` (Q4_K_M quantization)

---

## 2. Hosting Strategy (Malaysia)

**Phase 1 — Dev/self-use**: Run on laptop CPU. Socket Mode = no public URL needed. ~10s responses. Free.

**Phase 2 — Team (CPU)**: Oracle Cloud Free Tier Malaysia. ~12s responses. Free.

**Phase 3 — Team (GPU, optional)**: GCP/Vast.ai T4 GPU. ~2.5s responses. ~$150-200/mo.

| Provider | Region | Specs | Cost | Phase |
|----------|--------|-------|------|-------|
| **Oracle Cloud Free** | Malaysia (Kulai) | 4 ARM OCPU, 24GB RAM | **Free** | Phase 2 |
| Hetzner | Singapore | 4 vCPU, 8GB RAM | ~$15/mo | Phase 2 alt |
| **GCP T4** | Singapore | T4 GPU, 4 vCPU, 16GB | ~$197/mo | Phase 3 |
| Vast.ai | Varies | T4 / RTX 3060 | ~$150/mo | Phase 3 alt |

Oracle Cloud Malaysia gives free ARM Ampere instances — good enough for CPU inference. Upgrade to GPU (Phase 3) only if response time matters. See Section 19 for GPU analysis.

---

## 3. Architecture: Headless Slack Bot

### Why headless
- Slack IS the UI — no need for a web dashboard or desktop app
- Simpler deployment (one process, no ports to expose for UI)
- Admin tasks via slash commands + config file for initial setup
- Less code to maintain

### High-level architecture
```
┌──────────────┐     WebSocket (Socket Mode)      ┌─────────────────────────────┐
│              │◄──────────────────────────────────►│                             │
│  Slack       │     or HTTP (production)          │  Monday Bot (Node.js)       │
│  Workspace   │                                   │                             │
│              │     /ask, @Monday, /status,        │  ┌───────────────────────┐  │
│  Users type  │     /sync, /help, /feedback        │  │ Slack Bolt SDK        │  │
│  commands    │                                   │  │ (Socket/HTTP Mode)    │  │
│              │                                   │  └──────────┬────────────┘  │
└──────────────┘                                   │             │               │
                                                   │  ┌──────────▼────────────┐  │
                                                   │  │ RAG Pipeline          │  │
                                                   │  │ Query → Embed → Search│  │
                                                   │  │ → Prompt → LLM       │  │
                                                   │  └──────────┬────────────┘  │
                                                   │             │               │
                                                   │  ┌──────────▼────────────┐  │
                                                   │  │ Core Services         │  │
                                                   │  │ • Embedder (ONNX)     │  │
                                                   │  │ • Vector Index (hnsw) │  │
                                                   │  │ • LLM (node-llama)    │  │
                                                   │  │ • SQLite metadata     │  │
                                                   │  └──────────┬────────────┘  │
                                                   │             │               │
                                                   │  ┌──────────▼────────────┐  │
                                                   │  │ Background Services   │  │
                                                   │  │ • File Watcher        │  │
                                                   │  │ • Nightly Reindex     │  │
                                                   │  │ • Confluence Sync     │  │
                                                   │  └───────────────────────┘  │
                                                   └─────────────────────────────┘
                                                               │
                                                   ┌───────────▼───────────┐
                                                   │  File System          │
                                                   │  • docs/ (watched)    │
                                                   │  • index.hnsw         │
                                                   │  • meta.sqlite        │
                                                   │  • models/ (GGUF)     │
                                                   └───────────────────────┘
```

---

## 4. Project Structure

```
monday-bot/
├── src/
│   ├── index.ts                    # Entry point: init bot, start services
│   ├── config.ts                   # Type-safe config loading (env + yaml)
│   │
│   ├── slack/                      # Slack integration layer
│   │   ├── app.ts                  # Bolt app setup (Socket/HTTP mode)
│   │   ├── commands/
│   │   │   ├── ask.ts              # /ask <question> handler
│   │   │   ├── status.ts           # /status handler
│   │   │   ├── sync.ts             # /sync-confluence handler
│   │   │   ├── reindex.ts          # /reindex handler
│   │   │   ├── help.ts             # /help handler
│   │   │   └── feedback.ts         # /feedback handler
│   │   ├── events/
│   │   │   └── mention.ts          # @Monday mention handler
│   │   └── formatters/
│   │       └── blocks.ts           # Block Kit message formatting (citations, errors)
│   │
│   ├── rag/                        # RAG pipeline
│   │   ├── pipeline.ts             # Orchestrator: embed → search → prompt → generate
│   │   ├── prompt.ts               # Prompt template loading and formatting
│   │   └── types.ts                # QueryResult, Citation, ChunkMetadata types
│   │
│   ├── core/                       # Core services (singletons)
│   │   ├── embedder.ts             # Transformers.js embedding (all-MiniLM-L6-v2)
│   │   ├── vector-store.ts         # hnswlib-node index management
│   │   ├── llm.ts                  # node-llama-cpp wrapper (Qwen3.5-2B)
│   │   ├── database.ts             # better-sqlite3 metadata storage
│   │   └── extractor.ts            # Text extraction (PDF, DOCX, TXT, MD)
│   │
│   ├── indexing/                   # Document indexing pipeline
│   │   ├── watcher.ts              # chokidar file watcher
│   │   ├── scheduler.ts            # node-cron nightly reindex
│   │   ├── incremental.ts          # Add/remove docs without full rebuild
│   │   └── confluence.ts           # Confluence REST API sync
│   │
│   └── utils/
│       ├── logger.ts               # pino logger setup
│       ├── paths.ts                # Path normalization utilities
│       └── retry.ts                # Retry with exponential backoff
│
├── prompts/
│   └── retrieval.md                # RAG prompt template (same as current)
│
├── config/
│   └── default.yaml                # Default config (watch paths, model settings)
│
├── models/                         # GGUF model files (gitignored)
│   └── .gitkeep
│
├── tests/
│   ├── unit/
│   │   ├── embedder.test.ts
│   │   ├── vector-store.test.ts
│   │   ├── llm.test.ts
│   │   ├── extractor.test.ts
│   │   ├── pipeline.test.ts
│   │   └── database.test.ts
│   └── integration/
│       ├── rag-pipeline.test.ts
│       └── slack-handlers.test.ts
│
├── package.json
├── tsconfig.json
├── .env.example                    # SLACK_BOT_TOKEN, SLACK_APP_TOKEN, etc.
├── .gitignore
├── Dockerfile                      # For cloud deployment
├── docker-compose.yml              # Bot + optional services
└── README.md
```

---

## 5. Module Mapping (Python → TypeScript)

| Python Module | TypeScript Module | npm Package | Notes |
|---|---|---|---|
| `core/embedding.py` | `src/core/embedder.ts` + `src/core/vector-store.ts` | `@huggingface/transformers` + `hnswlib-node` | Split into embedding + index |
| `core/llm.py` | `src/core/llm.ts` | `node-llama-cpp` (v3.17) | Similar API, auto hardware detection |
| `core/ask.py` | `src/rag/pipeline.ts` | — | Pure orchestration logic |
| `core/extract.py` | `src/core/extractor.ts` | `pdf-parse` + `mammoth` | Direct swaps |
| `core/database.py` | `src/core/database.ts` | `better-sqlite3` | Sync API, same schema |
| `core/config.py` | `src/config.ts` | `yaml` + `dotenv` | Type-safe with interfaces |
| `core/confluence.py` | `src/indexing/confluence.ts` | `axios` (REST API direct) | No atlassian SDK needed |
| `core/path_utils.py` | `src/utils/paths.ts` | `path` (built-in) | Simpler in Node |
| `core/monitoring.py` | `src/slack/commands/status.ts` | — | Inline in status command |
| `daemon/watch.py` | `src/indexing/watcher.ts` | `chokidar` | Much simpler API |
| `daemon/file_queue.py` | `src/indexing/watcher.ts` | — | Built into watcher (debounce) |
| `daemon/embedding_adapter.py` | `src/indexing/incremental.ts` | — | Incremental hnswlib ops |
| `core/index_manager.py` | `src/indexing/incremental.ts` | — | Merged with incremental |
| `ui/flask_app.py` | **DROPPED** | — | Slack replaces web UI |
| `run_app.py` | `src/index.ts` | — | Entry point |
| `cli.py` | **DROPPED** | — | Slack replaces CLI |
| `smart_watcher.py` | `src/indexing/watcher.ts` | — | Integrated into main process |

**Dropped entirely**: `ui/`, `run_app.py` (PyWebView), `cli.py`, `smart_watcher.py`, `tools/`, `complete_setup.py`, `setup_auto_discovery.py`, `switch_documents.py`

---

## 6. Core TypeScript Types

```typescript
// src/rag/types.ts

interface ChunkMetadata {
  id: number;
  file: string;
  chunk: string;
  docChunkId: number;
  sourceUrl?: string;
}

interface QueryResult {
  chunkText: string;
  filePath: string;
  chunkId: number;
  docChunkId: number;
  score: number;
}

interface Citation {
  id: number;
  file: string;
  page: number;
  chunk: string;     // max 300 chars
  score: number;
}

interface RagResponse {
  answer: string;
  citations: Citation[];
  retrievalTimeMs: number;
  generationTimeMs: number;
}

// Section 15: Section-aware document extraction
interface Section {
  heading: string;         // e.g., "VPN Setup"
  startOffset: number;     // character offset in full text
  endOffset: number;
  level: number;           // 1=h1, 2=h2, 3=h3
  parents?: string[];      // parent headings for hierarchy
}

interface ExtractedDocument {
  text: string;
  sections: Section[];     // empty array if no headings detected
}

// src/config.ts

interface AppConfig {
  slack: {
    botToken: string;
    appToken: string;     // for Socket Mode
    signingSecret: string;
    socketMode: boolean;  // true for dev, false for production
  };
  llm: {
    modelPath: string;
    contextSize: number;  // 3072
    maxTokens: number;    // 300
    temperature: number;  // 0.1
    threads: number;      // 8
  };
  embedding: {
    modelName: string;    // "Xenova/all-MiniLM-L6-v2"
    dimension: number;    // 384
    chunkSize: number;    // 150 words
    chunkOverlap: number; // 40 words
    topK: number;         // 7
  };
  index: {
    path: string;         // "data/index.hnsw"
    dbPath: string;       // "data/meta.sqlite"
  };
  watcher: {
    paths: string[];
    patterns: string[];   // ["*.txt","*.pdf","*.docx","*.md"]
    debounceMs: number;   // 2000
    nightlyReindexHour: number; // 2 (2:00 AM)
  };
  confluence?: {
    url: string;
    email: string;
    apiToken: string;
    defaultSpace?: string;
  };
}
```

---

## 7. Slack Bot Design

### Commands & Events

| Interaction | Trigger | Behavior |
|---|---|---|
| `/ask <question>` | Slash command | Stream LLM answer in ephemeral → then post to thread |
| `@Monday <question>` | App mention | Stream answer as thread reply |
| `/monday-status` | Slash command | Show indexed docs count, watcher status, uptime |
| `/monday-sync` | Slash command | Trigger Confluence sync, report progress |
| `/monday-reindex` | Slash command | Trigger full reindex |
| `/monday-help` | Slash command | Show available commands and usage |
| `/monday-feedback <text>` | Slash command | Log user feedback for improvements |

### Message Flow for `/ask`

```
User: /ask How do I configure the VPN?
  │
  ├─ 1. ack() immediately (Slack 3s timeout)
  ├─ 2. Post "Searching..." message to channel/thread
  ├─ 3. Embed query → search hnswlib (top 7)
  ├─ 4. If no relevant results (score > threshold):
  │     └─ Update message: "No relevant documents found."
  ├─ 5. Build prompt with chunks + question
  ├─ 6. Stream LLM response, updating message every ~500ms
  ├─ 7. Final message with:
  │     ├─ Answer text with [1], [2] inline citations
  │     └─ Citation block (Block Kit) with file names + links
  └─ 8. Log query + response time for analytics
```

### Block Kit Message Format (for citations)

```typescript
// Answer with citations rendered as Slack blocks
{
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "To configure the VPN, go to Settings > Network and enter the server address [1]. Make sure to enable split tunneling for local resources [2]."
      }
    },
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "📄 *Sources:*\n[1] `IT-Guide/vpn-setup.pdf` (p.3)\n[2] `IT-Guide/network-config.md` (p.1)"
        }
      ]
    }
  ]
}
```

### Streaming Strategy

Use Slack's `chat.update` to progressively update the message as tokens arrive:
1. Post initial message with "Thinking..."
2. Buffer tokens, update message every ~500ms (avoid rate limits)
3. Final update with complete answer + citation blocks

If `chatStream()` is available in Bolt SDK, use that instead for native streaming support.

### Admin via Slack

**Why Slack-only admin (no web panel):**
- Fits the headless philosophy
- No extra port/server to manage
- Team members can see admin actions in the channel

**What goes in config file instead of Slack commands:**
- Watch paths (initial setup) → `config/default.yaml`
- Slack tokens, Confluence creds → `.env`
- Model settings → `config/default.yaml`

**What works well as Slack commands:**
- `/monday-status` — quick status check
- `/monday-sync` — trigger Confluence sync
- `/monday-reindex` — trigger full reindex
- `/monday-help` — usage guide

---

## 8. RAG Pipeline Design

### Query Flow (`src/rag/pipeline.ts`)

```typescript
import { loadPromptTemplate } from "./prompt";

// Load the facts-only prompt (Section 18: 9 rules, 200-word max, no reasoning)
const promptTemplate = loadPromptTemplate("prompts/retrieval.md");

async function answerQuestion(
  query: string,
  options: { topK?: number; stream?: boolean }
): Promise<RagResponse> {
  // 1. Embed query
  const queryVector = await embedder.embed(query); // 384-dim float32

  // 2. Search vector index (top 7 — Section 20)
  const results = vectorStore.search(queryVector, options.topK ?? 7);

  // 3. Filter by relevance threshold (1.2 L2 distance)
  const relevant = results.filter(r => r.score < RELEVANCE_THRESHOLD);

  // 4. Build citations
  //    Note: chunk text may include section heading prefix (Section 15)
  //    e.g., "VPN Setup > Configuration: Enter the server address..."
  //    Strip the heading prefix for citation display, keep it for context
  const citations = relevant.map((r, i) => ({
    id: i + 1,
    file: r.filePath,
    page: calculatePage(r.docChunkId),
    chunk: stripSectionPrefix(r.chunkText).slice(0, 300),
    score: r.score,
  }));

  // 5. Format prompt using Section 18 facts-only template
  //    Chunk text sent to LLM includes section headings (Section 15)
  //    This helps the LLM understand document structure without reasoning
  const context = relevant.map((r, i) => `[${i + 1}] ${r.chunkText}`).join("\n\n");
  const prompt = promptTemplate
    .replace("{question}", query)
    .replace("{context}", context);

  // 6. Generate facts-only answer via LLM (300 max_tokens — Section 16)
  const answer = await llm.generate(prompt, {
    maxTokens: config.llm.maxTokens,   // 300
    temperature: config.llm.temperature, // 0.1
    stopSequences: ["<|im_end|>", "\n\nQuestion:", "\n\nContext:"],
  });

  return { answer, citations, retrievalTimeMs, generationTimeMs };
}

// Helper: strip "Section > Subsection: " prefix for clean citation display
function stripSectionPrefix(chunkText: string): string {
  const colonIndex = chunkText.indexOf(": ");
  if (colonIndex > 0 && colonIndex < 80) {
    // Check if prefix looks like a heading (contains > or is short)
    const prefix = chunkText.slice(0, colonIndex);
    if (prefix.includes(">") || prefix.length < 60) {
      return chunkText.slice(colonIndex + 2);
    }
  }
  return chunkText;
}
```

### Streaming Variant

```typescript
async function* streamAnswer(query: string, topK = 7): AsyncGenerator<string> {
  // Steps 1-5 same as above (section-aware context, facts-only prompt)
  // Step 6: stream tokens — LLM generates facts-only answer progressively
  for await (const token of llm.stream(prompt, options)) {
    yield token;
  }
}
```

### Key Design Decisions in This Pipeline

1. **Section headings stay in context** (Section 15): The LLM sees `[1] VPN Setup > Configuration: Enter the server address...` — this helps it understand which section the chunk belongs to, producing more organized answers without needing reasoning.

2. **Section headings stripped from citations** (Section 15): The user sees `"Enter the server address..."` in the citation preview, not the heading prefix. Cleaner display.

3. **Facts-only prompt** (Section 18): The 9-rule prompt in `prompts/retrieval.md` ensures the LLM reports what the documents say, not its own conclusions. Rule 9 makes it say "I found X but the documents don't cover Y" instead of guessing.

---

## 9. Indexing Pipeline Design

### File Watcher (`src/indexing/watcher.ts`)

```typescript
import chokidar from "chokidar";

// Watch configured paths with debouncing
const watcher = chokidar.watch(config.watcher.paths, {
  ignored: ["**/node_modules/**", "**/.git/**", "**/*.tmp"],
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 2000 }, // built-in debounce
});

watcher
  .on("add", (path) => indexingQueue.add(path))
  .on("change", (path) => indexingQueue.update(path))
  .on("unlink", (path) => indexingQueue.remove(path));
```

### Incremental Indexing with Section-Aware Chunking (`src/indexing/incremental.ts`)

```typescript
import { ExtractedDocument, Section } from "../rag/types";

async function addDocument(filePath: string): Promise<void> {
  // 1. Remove existing chunks for this file (handles updates)
  await removeDocument(filePath);

  // 2. Extract text WITH section detection (Section 15)
  //    Returns { text, sections[] } where sections have heading + offsets
  const doc: ExtractedDocument = await extractor.extract(filePath);
  if (!doc.text) return;

  // 3. Chunk text with section-aware prefixing (Section 15)
  //    Each chunk gets its nearest heading prepended before embedding
  const rawChunks = chunkText(doc.text, config.embedding.chunkSize, config.embedding.chunkOverlap);
  const chunks = chunkWithSections(rawChunks, doc.sections);
  // Example: "VPN Setup > Configuration: Enter the server address..."

  // 4. Embed all chunks in one batch call
  //    Section headings in the chunk text make the embedding "section-aware"
  //    A query for "VPN setup" will naturally match heading-tagged chunks higher
  const vectors = await embedder.embedBatch(chunks);

  // 5. Add to hnswlib index + SQLite
  const baseId = database.getNextId();
  for (let i = 0; i < chunks.length; i++) {
    vectorStore.addPoint(baseId + i, vectors[i]);
    database.insertChunk(baseId + i, filePath, chunks[i], i + 1);
  }

  // 6. Save index to disk
  vectorStore.save();
}

// Section 15: Prepend nearest heading to each chunk
function chunkWithSections(chunks: ChunkWithOffset[], sections: Section[]): string[] {
  return chunks.map(chunk => {
    const section = findSectionForOffset(sections, chunk.startOffset);
    if (section) {
      // Build hierarchy: "Parent > Child: chunk text"
      const heading = section.parents
        ? [...section.parents, section.heading].join(" > ")
        : section.heading;
      return `${heading}: ${chunk.text}`;
    }
    return chunk.text; // No section detected — use raw text
  });
}

// Find the section that contains a given text offset
function findSectionForOffset(sections: Section[], offset: number): Section | null {
  // Walk backwards through sections to find the last heading before this offset
  let best: Section | null = null;
  for (const section of sections) {
    if (section.startOffset <= offset) {
      best = section;
    } else {
      break; // Sections are sorted by offset
    }
  }
  return best;
}
```

### Nightly Reindex (`src/indexing/scheduler.ts`)

```typescript
import cron from "node-cron";

// Run at 2:00 AM daily
cron.schedule("0 2 * * *", async () => {
  logger.info("Starting nightly full reindex...");
  await vectorStore.clear();
  database.clearAll();
  for (const watchPath of config.watcher.paths) {
    const files = glob.sync(`${watchPath}/**/*.{txt,pdf,docx,md}`);
    for (const file of files) {
      await addDocument(file); // Uses section-aware chunking (Section 15)
    }
  }
  logger.info("Nightly reindex complete.");
});
```

### Section Detection per File Type (`src/core/extractor.ts`)

```typescript
interface Section {
  heading: string;         // e.g., "VPN Setup"
  startOffset: number;     // character offset in full text
  endOffset: number;
  level: number;           // 1=h1, 2=h2, 3=h3
  parents?: string[];      // parent headings for hierarchy
}

interface ExtractedDocument {
  text: string;
  sections: Section[];
}

// Detection strategies per file type:
//
// Markdown:   /^(#{1,3})\s+(.+)$/gm  → heading level from # count
// DOCX:       mammoth paragraph styles "Heading 1/2/3" → heading
// PDF:        font-size heuristics (>14pt = heading, bold = subheading)
// Confluence: <h1>, <h2>, <h3> from HTML storage format
// TXT:        ALL CAPS lines, or lines followed by === / ---

async function extract(filePath: string): Promise<ExtractedDocument> {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".md":  return extractMarkdown(filePath);
    case ".docx": return extractDocx(filePath);
    case ".pdf":  return extractPdf(filePath);
    case ".txt":  return extractTxt(filePath);
    default:      return { text: await fs.readFile(filePath, "utf-8"), sections: [] };
  }
}
```

---

## 10. npm Dependencies

### Production
```json
{
  "@slack/bolt": "^4.x",
  "node-llama-cpp": "^3.17",
  "@huggingface/transformers": "^3.x",
  "hnswlib-node": "^3.x",
  "better-sqlite3": "^11.x",
  "chokidar": "^4.x",
  "node-cron": "^3.x",
  "pdf-parse": "^1.x",
  "mammoth": "^1.x",
  "axios": "^1.x",
  "yaml": "^2.x",
  "dotenv": "^16.x",
  "pino": "^9.x",
  "pino-pretty": "^11.x",
  "glob": "^11.x"
}
```

### Development
```json
{
  "typescript": "^5.x",
  "tsx": "^4.x",
  "@types/node": "^22.x",
  "@types/better-sqlite3": "^7.x",
  "vitest": "^3.x",
  "eslint": "^9.x",
  "@typescript-eslint/eslint-plugin": "^8.x"
}
```

---

## 11. Configuration & Environment

### `.env` (secrets)
```env
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...      # Socket Mode
SLACK_SIGNING_SECRET=...

# Confluence (optional)
CONFLUENCE_URL=https://your-domain.atlassian.net
CONFLUENCE_EMAIL=your@email.com
CONFLUENCE_API_TOKEN=...

# Model
MODEL_PATH=./models/qwen3.5-2b-instruct-q4_k_m.gguf
```

### `config/default.yaml` (non-secret settings)
```yaml
watcher:
  paths:
    - ./docs
  patterns:
    - "*.txt"
    - "*.pdf"
    - "*.docx"
    - "*.md"
  debounceMs: 2000
  nightlyReindexHour: 2

llm:
  contextSize: 3072
  maxTokens: 300
  temperature: 0.1
  threads: 8

embedding:
  model: "Xenova/all-MiniLM-L6-v2"
  dimension: 384
  chunkSize: 150
  chunkOverlap: 40
  topK: 7

index:
  path: "./data/index.hnsw"
  dbPath: "./data/meta.sqlite"
  relevanceThreshold: 1.2
```

---

## 12. Migration & Compatibility Notes

### Breaking Changes
- **FAISS → hnswlib**: Index files are NOT compatible. Requires one-time re-indexing of all documents.
- **No web UI**: Users interact only via Slack. No browser-based search.
- **No CLI**: No command-line query interface.
- **No desktop app**: No PyWebView window.

### What Stays the Same
- **Prompt template**: Same retrieval_prompt.md with `{question}` and `{context}` placeholders
- **Embedding model**: all-MiniLM-L6-v2 (384-dim) — ONNX version produces near-identical vectors
- **SQLite schema**: Same `meta` table with id, file, chunk, doc_chunk_id, source_url
- **Citation format**: `[1]`, `[2]` inline references
- **Relevance threshold**: 1.2 (L2 distance)
- **Confluence sync logic**: Same page-by-page fetch + incremental versioning

### What Changed from Python Version
- **Chunking logic**: 200→150 words, 50→40 word overlap (see Section 20 for rationale)
- **Top-K retrieval**: 3→7 chunks (more source material for 200-word answers)
- **Context window**: 2048→3072 tokens (right-sized for 7 chunks at 150 words)

### One-time Setup
1. Create Slack App at api.slack.com
2. Enable Socket Mode + Event Subscriptions
3. Add slash commands: `/ask`, `/monday-status`, `/monday-sync`, `/monday-reindex`, `/monday-help`, `/monday-feedback`
4. Add bot scopes: `chat:write`, `commands`, `app_mentions:read`
5. Install to workspace
6. Download Qwen3.5-2B GGUF model
7. Place documents in `./docs/` folder
8. Run `npm start` — bot indexes docs and connects to Slack

---

## 13. Implementation Phases

### Phase 1: Core Foundation (Week 1)
Files to create:
- `src/config.ts` — config loading (3072 context, 300 max_tokens, topK 7 — Section 20)
- `src/core/database.ts` — better-sqlite3 wrapper (same schema as Python)
- `src/core/extractor.ts` — PDF/DOCX/TXT/MD extraction **with section detection** (Section 15: parse headings from MD/DOCX/PDF/TXT, return `ExtractedDocument` with `sections[]`)
- `src/core/embedder.ts` — Transformers.js embedding
- `src/core/vector-store.ts` — hnswlib-node index
- `src/core/llm.ts` — node-llama-cpp wrapper (auto hardware detection — Section 17)
- `src/rag/types.ts` — TypeScript interfaces (including `Section`, `ExtractedDocument` types for Section 15)
- `src/rag/prompt.ts` — prompt template loader (**Section 18 facts-only prompt** with 9 rules, single source of truth)
- `src/rag/pipeline.ts` — RAG orchestration (top 7 chunks, 300 max_tokens)
- `src/utils/logger.ts` — pino setup
- `src/utils/paths.ts` — path utilities
- `prompts/retrieval.md` — **Section 18 final prompt** (facts-only, 200-word max, 9 rules)

**Section 15 integration in this phase:**
- `extractor.ts` returns `{ text, sections[] }` — sections detected per file type (MD headers, DOCX heading styles, PDF font-size heuristics, TXT ALL CAPS lines)
- No section detection = chunks still work fine (graceful fallback)

**Section 18 integration in this phase:**
- `prompts/retrieval.md` uses the final 9-rule prompt from Section 18 (includes Rule 2: "report facts, not interpretations" and Rule 9: "say what you found and what's missing")

**Verification**: Run a query programmatically (no Slack yet) and get a 200-word facts-only answer with citations. Test with a structured MD file to verify section headings appear in chunk text.

### Phase 2: Slack Integration (Week 2)
Files to create:
- `src/slack/app.ts` — Bolt setup (Socket Mode for dev — Section 17)
- `src/slack/commands/ask.ts` — /ask handler with streaming (200-word answers — Section 16)
- `src/slack/commands/status.ts` — /status handler
- `src/slack/commands/help.ts` — /help handler
- `src/slack/events/mention.ts` — @mention handler
- `src/slack/formatters/blocks.ts` — Block Kit formatting (citations with source links)

**Verification**: Send `/ask` in Slack, get streamed facts-only answer with citations in thread.

### Phase 3: Indexing Pipeline (Week 3)
Files to create:
- `src/indexing/watcher.ts` — chokidar watcher
- `src/indexing/incremental.ts` — add/remove/update documents **with section-aware chunking** (Section 15: prepend nearest heading to each chunk before embedding)
- `src/indexing/scheduler.ts` — nightly reindex cron

**Section 15 integration in this phase:**
- `incremental.ts` calls `chunkWithSections()` — prepends section heading to chunk text before embedding
- Example: `"VPN Setup > Configuration: Enter the server address..."` instead of just `"Enter the server address..."`
- Chunks without detected sections remain unchanged (no heading prefix)

**Verification**: Add a structured DOCX with headings → verify chunks include section names. Add/modify/delete a file in docs/ → see it reflected in search results within 5 seconds.

### Phase 4: Confluence + Polish (Week 4)
Files to create:
- `src/indexing/confluence.ts` — REST API sync (**Section 15: extract `<h1>`-`<h3>` from Confluence HTML for section-aware chunking**)
- `src/slack/commands/sync.ts` — /sync handler
- `src/slack/commands/reindex.ts` — /reindex handler
- `src/slack/commands/feedback.ts` — /feedback handler
- `Dockerfile` + `docker-compose.yml` — deployment

**Section 15 integration in this phase:**
- Confluence pages have `<h1>`, `<h2>`, `<h3>` tags in their HTML storage format — these are the most reliable source of section headings
- `confluence.ts` extracts these headings and passes them as `sections[]` to the chunking pipeline

**Verification**: Sync a Confluence space → verify page section headings appear in chunk text → search for a section title → verify it returns relevant chunks from that section.

### Phase 5: Testing & Deployment
Files to create:
- `tests/unit/*.test.ts` — unit tests for each core module
  - `extractor.test.ts` — verify section detection for MD, DOCX, PDF, TXT, and Confluence HTML (Section 15)
  - `pipeline.test.ts` — verify facts-only answers (no reasoning/interpretation in output) (Section 18)
  - `pipeline.test.ts` — verify "I found X but couldn't find Y" behavior when context is incomplete (Section 18 Rule 9)
- `tests/integration/*.test.ts` — end-to-end RAG + Slack tests

**Section 15 verification:**
- Test: Index a file with clear headings → query for a heading title → verify the heading-tagged chunks score higher than untagged chunks
- Test: Index a file without headings → verify chunks still work normally

**Section 18 verification:**
- Test: Ask a question where the answer requires reasoning → verify Monday says "the documents don't cover this" instead of guessing
- Test: Ask a factual question → verify answer only contains information from the source chunks

**Verification**: All tests pass. Deploy to Oracle Cloud Malaysia. Team members can use the bot.

---

## 14. Verification Plan

1. **Unit tests**: Each core module (embedder, vector-store, llm, extractor, database) has isolated tests with vitest
2. **RAG pipeline test**: Index sample docs → query → verify answer contains relevant content with citations
3. **Slack integration test**: Bot connects to test workspace → `/ask` returns formatted response
4. **File watcher test**: Add file → verify it appears in search results within 5 seconds
5. **Confluence sync test**: Sync test space → verify pages are searchable
6. **Performance test**: Query response time < 12s on CPU, < 5s on GPU (embedding + search + LLM generation)
7. **Docker test**: Build image → run container → verify bot connects and responds

---

## 15. RAG Enhancement: Section-Aware Chunking (NOT full TOC mapping)

### Evaluation of TOC-Aware RAG

**Full TOC mapping is NOT recommended** for this app because:

1. **Scale is too small** — Hundreds to low thousands of documents. The "crowded room" problem (where "revenue" grabs "risks" chunks) mainly hits at 100K+ chunks. At our scale, hnswlib + 384-dim embeddings + relevance threshold (1.2) already separate topics well.

2. **Most docs lack structure** — TXT, MD files are often flat. TOC parsing only helps well-structured PDFs/Confluence. Creates an inconsistent two-tier system.

3. **200-word fact-based answers with 150-word chunks are still forgiving** — The prompt constrains Monday to report facts only (no reasoning), with strict citation rules. Even a slightly off-topic chunk won't derail a factual answer. The 150-word chunks (Section 20) are more focused, further reducing the risk of off-topic noise.

4. **Engineering cost is high** — TOC parsing needs: header detection per format, hierarchy building, section summarization (extra LLM call), two-stage search, and fallbacks. Too much for the current scope.

### What to do instead: Section-Aware Chunking

A simpler approach that gives ~80% of the benefit with ~10% of the effort:

**Before embedding, prepend the nearest heading/section title to each chunk.**

```
Current:    "Enter the VPN server address in the field..."
Enhanced:   "VPN Setup > Configuration: Enter the VPN server address in the field..."
```

This makes the embedding vector inherently "section-aware" — a query for "VPN setup" will strongly match chunks tagged with that heading, even if the chunk text itself is generic.

**Implementation per file type:**

| Format | How to detect sections |
|--------|----------------------|
| Markdown | Parse `#`, `##`, `###` headers |
| DOCX | Detect `Heading 1/2/3` paragraph styles via mammoth |
| PDF | Font-size heuristics (larger text = heading) |
| Confluence | `<h1>`, `<h2>`, `<h3>` tags from HTML |
| TXT | Line that is ALL CAPS or followed by `===`/`---` |

**Where it goes in the code:**

In `src/core/extractor.ts`, the `extract()` function returns:
```typescript
interface ExtractedDocument {
  text: string;
  sections: Section[];  // [{heading: "VPN Setup", startOffset: 0, endOffset: 450}, ...]
}
```

In `src/indexing/incremental.ts`, the chunking step prepends the section heading:
```typescript
function chunkWithSections(doc: ExtractedDocument): string[] {
  return chunks.map(chunk => {
    const section = findSectionForOffset(doc.sections, chunk.offset);
    return section ? `${section.heading}: ${chunk.text}` : chunk.text;
  });
}
```

No two-stage search. No summary generation. No hierarchy index. Just better chunks.

### When to revisit full TOC mapping

- If document count exceeds 5,000+ files
- If answer quality drops noticeably with more data
- If you upgrade to 9B+ model and want longer, synthesized answers
- If most of your corpus becomes structured documents (PDFs, Confluence)

---

## 16. Answer Length Enhancement: Upgrade from 50 → 200 Words

### The Problem (ELI5)

The current system is like a librarian who can ONLY say: *"The answer is on page 3 of the VPN guide"* (50 words max). That was a smart constraint for the old Qwen2.5-1.5B model — it wasn't smart enough to write longer answers without rambling or making things up.

But with Qwen3.5-2B (2x intelligence), the librarian can now **read the page and explain it to you** in a helpful summary. Restricting it to 50 words wastes the model's capability.

### Verdict: Yes, enhance this. Here's the full analysis.

### What changes and why

| Setting | Current | Proposed | Why |
|---------|---------|----------|-----|
| **Prompt max words** | 50 | **200** | Room for a proper summary paragraph with context |
| **`max_tokens`** | 100 | **300** | ~200 words ≈ ~270 tokens. 300 gives buffer for citations |
| **`n_ctx`** | 2048 | **3072** | Right-sized for 7 chunks at 150 words (see Section 20) |
| **`top_k` chunks** | 3 | **7** | More source material = better synthesized answer (see Section 20) |
| **Chunk size** | 200 words | **150 words** | 100% embedding coverage, better precision (see Section 20) |
| **Chunk overlap** | 50 words | **40 words** | 26.7% overlap ratio, proportionally better than before |

### Why each change matters

**1. Prompt: 50 → 200 words**

At 50 words, the AI can only do one thing: point you to the right document. It can't explain, summarize, or synthesize. Example:

```
50-word answer:
"Configure VPN by going to Settings > Network [1]. Enter the server address provided by IT [2]."

200-word answer:
"To configure the company VPN, open Settings > Network > VPN on your device [1].
You'll need the server address (vpn.company.com) and your AD credentials [2].

Key steps:
1. Select 'IKEv2' as the VPN type
2. Enter the server address from the IT welcome email
3. Use your Windows login credentials
4. Enable 'Split tunneling' so local network still works [3]

Common issues: If connection fails, check that you're not on a restricted WiFi
network. Hotel and airport WiFi often block VPN ports [2]."
```

The 200-word answer is actually **useful** — a team member can solve their problem without opening the source document. The 50-word answer just sends them to read the document themselves.

**2. max_tokens: 100 → 300**

Tokens ≠ words. English averages ~1.3 tokens per word. For 200 words:
- 200 words × 1.3 = ~260 tokens
- Add 40 tokens buffer for citation markers `[1]`, formatting
- = **300 tokens**

On CPU with Qwen3.5-2B at ~30 tok/s, 300 tokens takes ~10 seconds (vs ~3.3s for 100 tokens). This is acceptable for Slack where users expect a brief wait.

**3. n_ctx: 2048 → 3072**

The context window holds: system prompt + retrieved chunks + generated answer.

Current budget (2048 tokens):
- System prompt: ~100 tokens
- 3 chunks × ~260 tokens = ~780 tokens
- Answer: ~100 tokens
- **Total: ~980 tokens** (fits, but tight)

New budget (3072 tokens):
- System prompt: ~120 tokens
- 7 chunks × ~210 tokens = ~1,470 tokens
- Answer: ~300 tokens
- **Total: ~1,940 tokens** (comfortable headroom of ~1,132 tokens)
- Supports up to top-K=10 without window change (see Section 20)

3072 is right-sized for 150-word chunks with top-K=7. The 4096 window wastes ~2,346 tokens of KV cache RAM. Qwen3.5-2B supports 262K context, so 3072 is trivial for the model. Going from 4096→3072 saves ~64 MB KV cache RAM — helpful on the Oracle ARM free tier (24 GB shared).

**4. top_k: 3 → 7 chunks**

More source chunks = better synthesized answers. With 50-word answers, 3 chunks was plenty (you could barely reference them all). With 200-word answers, the AI can meaningfully reference 7 sources to give a more complete picture. The 150-word chunks (Section 20) are more focused, so 7 chunks provides 1,050 words of recall — 5% more than the original 5×200=1,000 — while each individual chunk is more precisely relevant.

### What to change in the TypeScript rewrite

**`prompts/retrieval.md`** — Final prompt (see Section 18 for the definitive version with facts-only rule):
```markdown
(See Section 18 for the single source of truth prompt template)
```

**`config/default.yaml`** — Updated LLM settings:
```yaml
llm:
  contextSize: 3072    # was 2048 (right-sized for 150w chunks × 7 — Section 20)
  maxTokens: 300       # was 100
  temperature: 0.1     # unchanged
  threads: 8           # unchanged

embedding:
  chunkSize: 150       # was 200 (100% embedding coverage — Section 20)
  chunkOverlap: 40     # was 50 (26.7% overlap ratio)
  topK: 7              # was 3 (compensates smaller chunks with more retrieval slots)
```

**`src/rag/pipeline.ts`** — Updated default:
```typescript
async function answerQuestion(query: string, options: { topK?: number } = {}) {
  const topK = options.topK ?? 7;  // was 3 (Section 20: optimized for 150w chunks)
  // ... rest of pipeline
}
```

### Speed impact

| Setting | Current | New | Speed Impact |
|---------|---------|-----|-------------|
| Retrieval (7 vs 3 chunks) | ~0.1s | ~0.15s | Negligible |
| Context processing (1,470 vs 780 tokens) | ~4s | ~7.5s | +3.5s on CPU |
| LLM generation (300 vs 100 tokens) | ~3.3s | ~10s | +6.7s on CPU |
| **Total response time** | **~3.5s** | **~10-14s** | Acceptable for Slack |

10 seconds is fine for Slack — users send a message and check back. The streaming display (tokens appearing progressively) makes the wait feel shorter.

### Speed presets (keep flexibility)

Carry over the speed preset concept for power users:
```yaml
presets:
  quick:     { maxTokens: 100, topK: 4 }   # ~4s — fast, citation-focused
  standard:  { maxTokens: 300, topK: 7 }   # ~10-14s — helpful summaries (DEFAULT)
  detailed:  { maxTokens: 500, topK: 9 }   # ~15-20s — thorough, multi-source
```

Users could eventually choose via `/ask --quick How do I reset my password?` — but default is `standard`. All presets use 150-word chunks (Section 20).

### Question length

No artificial limit needed on question length. The user's question is embedded into a 384-dim vector regardless of length (sentence-transformers handles truncation at 256 tokens). For the prompt, the question typically uses <50 tokens. Even a paragraph-long question fits comfortably in 4096 context.

For Slack, the slash command input is naturally limited to ~3000 characters by Slack's API, which is more than enough.

---

## 17. Hardware Auto-Detection: Laptop → Cloud (ELI5)

### Does node-llama-cpp auto-detect hardware?

**Yes, fully automatic.** You write `getLlama()` with no parameters and it figures out the rest.

Detection priority:
```
1. CUDA  (NVIDIA GPU)  — fastest, auto-detected if CUDA Toolkit installed
2. Vulkan (any GPU)    — cross-platform GPU fallback
3. Metal  (Apple M1+)  — auto on macOS
4. CPU    (fallback)   — always works
```

**When you move from laptop to cloud, you change nothing in the code.** The same `getLlama()` call will:
- On your laptop (CPU only) → use CPU with 8 threads
- On Oracle Cloud ARM (no GPU) → use CPU with 4 ARM cores
- On a GPU instance (if you ever get one) → auto-offload to GPU

node-llama-cpp v3 ships with pre-built binaries for CUDA (Windows/Linux) and Vulkan. No compilation needed in most cases.

### Does Oracle Cloud Free Tier have GPU?

**No.** The free tier gives you **ARM Ampere A1 CPU only** (4 OCPUs, 24GB RAM). No GPU.

But here's the thing — **you don't need GPU for Qwen3.5-2B**:

| Hardware | Qwen3.5-2B Q4_K_M Speed | Good Enough? |
|----------|------------------------|-------------|
| Your laptop CPU (x86) | ~25-35 tok/s | Yes |
| Oracle ARM Ampere A1 (4 cores) | ~20-30 tok/s | Yes |
| NVIDIA T4 GPU (cheapest cloud GPU) | ~80-120 tok/s | Overkill |

At 300 max_tokens with ~25 tok/s on ARM, that's ~12 seconds per answer. For a Slack bot where users send a message and check back, this is perfectly fine. Streaming makes the wait feel even shorter.

### If you want GPU later (paid options)

| Provider | GPU | Cost | Use Case |
|----------|-----|------|----------|
| Oracle A10 | NVIDIA A10 | ~$1-2/hr | If you upgrade to 9B model |
| Lambda Labs | NVIDIA A10G | ~$0.75/hr | Budget GPU cloud |
| Vast.ai | Various | ~$0.30/hr | Cheapest spot GPUs |

**Recommendation**: Start CPU-only. GPU is only worth it if you upgrade to Qwen3.5-9B or serve 50+ concurrent users.

### What to configure in `src/core/llm.ts`

```typescript
import { getLlama, LlamaChatSession } from "node-llama-cpp";

// Auto-detects hardware — no GPU/CPU flag needed
const llama = await getLlama();  // That's it. No config.

const model = await llama.loadModel({
  modelPath: config.llm.modelPath,
});

const context = await model.createContext({
  contextSize: config.llm.contextSize,  // 3072
  threads: config.llm.threads,          // auto-detected if not set
});
```

No `n_gpu_layers` flag. No `GPU_LAYERS` env var. node-llama-cpp handles it automatically.

---

## 18. Reasoning vs Facts-Only Mode (ELI5)

### The Question

Should Monday **reason and infer** from the documents (like "based on X and Y, the likely answer is Z"), or should she **strictly report facts** only (like "according to document X, the answer is Z")?

### Verdict: Facts-only. Here's why.

**ELI5**: Imagine Monday is a new employee who just joined the team. She has access to all the company documents but has zero personal experience. Would you trust her to:

- (A) **Read the document and tell you what it says** → Yes, reliable
- (B) **Read the document and make her own conclusions** → Risky, she might be wrong

Option A is facts-only. Option B is reasoning. For a company knowledge assistant, **facts-only is the right default** because:

### Why facts-only is better for this app

**1. Trust and accuracy matter most**

When a team member asks "What's our refund policy?", they need the **actual policy**, not Monday's interpretation of it. If Monday reasons and gets it wrong, the team member might give a customer wrong information. With facts-only, Monday either quotes the document or says "I don't know" — both are safe.

**2. The 2B model's reasoning isn't reliable enough**

Qwen3.5-2B (Intelligence Index 16) is great at extracting and summarizing facts. But reasoning — connecting dots, drawing conclusions, inferring unstated information — requires stronger models (9B+, Intelligence Index 30+). A 2B model reasoning can produce plausible-sounding but wrong conclusions.

**3. Citations become meaningless with reasoning**

With facts-only, `[1]` means "this fact comes from document 1". Users can verify.
With reasoning, the AI might say "Based on [1] and [2], it seems likely that..." — but that conclusion doesn't exist in either document. The citation is misleading.

**4. "I don't know" is better than a wrong guess**

Facts-only mode naturally produces "I couldn't find relevant information" when the answer isn't in the documents. Reasoning mode would try to guess, which is dangerous for company-internal knowledge.

### Final Prompt Template (single source of truth for `prompts/retrieval.md`)

```markdown
You are Monday, an AI knowledge assistant. Answer using ONLY the provided context.

Rules:
1. Use ONLY the context provided — do not add external knowledge
2. Do NOT reason beyond what the documents state — report facts, not interpretations
3. Cite sources inline as [1], [2], etc.
4. NO fake citations — only cite chunks you actually used
5. NO citation list at the end (inline citations only)
6. Keep answer concise but helpful (max 200 words)
7. Structure with short paragraphs or bullet points when appropriate
8. Prioritize the most relevant information first
9. If the context doesn't fully answer the question, say what you found and what's missing

Question: {question}

Context:
{context}

Answer:
```

This prompt combines:
- **200-word answers** (Section 16) — enough for useful summaries
- **Facts-only** (Section 18) — Rule 2 prevents reasoning/interpretation
- **Honest gaps** — Rule 9: instead of guessing, Monday says "I found X but the documents don't cover Y"

### Example comparison

**User asks**: "Can I work from home on Fridays?"

**Facts-only (recommended):**
> According to the Remote Work Policy, employees may work remotely up to 2 days per week with manager approval [1]. The policy doesn't specify which days are allowed — check with your manager for team-specific arrangements [1].

**With reasoning (not recommended):**
> Based on the Remote Work Policy allowing 2 remote days per week [1], and the team meeting schedule showing no Friday meetings [2], it seems likely that Friday would be a good day to work from home. However, you should confirm with your manager.

The reasoning version sounds helpful but makes an inference ("no Friday meetings = good for WFH") that could be wrong — maybe Friday meetings just aren't in the document.

### When to revisit reasoning mode

- If you upgrade to **Qwen3.5-9B** (Intelligence Index 32) — reasoning becomes more reliable
- If you add a **confidence score** system — only show reasoning when confidence > 90%
- If you build a **fact-check step** — verify reasoning against source before showing to user
- If users explicitly request it — e.g., `/ask --reason What might be causing the build failures?`

---

## 19. Hitting the 5-Second Target: GPU vs Smaller Model

### The Math (ELI5)

The ~10s response time comes from LLM generation: **300 tokens ÷ ~30 tok/s on CPU = ~10 seconds.**

To get to 5 seconds, you either need the LLM to talk **twice as fast** (GPU) or tell it to **say less** (fewer tokens / smaller model).

### Three paths compared

| Path | How | Speed | Answer Quality | Monthly Cost |
|------|-----|-------|---------------|-------------|
| **A. GPU cloud** | Qwen3.5-2B on T4 GPU | ~2.5s (120 tok/s) | Best (Intelligence 16) | $144–$288/mo |
| **B. Smaller model** | Qwen3.5-0.8B on CPU | ~6-7s (45 tok/s) | Lower (Intelligence 9) | Free |
| **C. Fewer tokens** | Qwen3.5-2B, 200 max_tokens | ~7s (30 tok/s) | Good (shorter answers) | Free |
| **D. Hybrid** | Qwen3.5-0.8B on CPU, 200 tokens | ~4.5s | Adequate (Intelligence 9) | Free |

### Recommendation: Path A (GPU) for team use

For personal dev, Path C or D works fine. But for **team use (2-15 people)**, Path A is the right choice because:

1. **Quality matters more than cost** — Your team relies on Monday for accurate answers from company documents. Intelligence Index 9 (0.8B) vs 16 (2B) is a real difference in answer quality, especially for 200-word summarized answers.

2. **$150/mo is reasonable for a team tool** — That's $10-75/person/month for 2-15 people. Compare with Notion AI ($10/user), Glean ($25/user), or Guru ($15/user). Monday at $150/mo total is cheap.

3. **Speed compounds** — If 15 people each ask 5 questions/day, that's 75 queries. At 10s each, peak hours can queue up. At 2.5s, no noticeable delays.

### Cheapest GPU options (Asia-friendly)

| Provider | GPU | $/hr | $/month (24/7) | Region | Reliability |
|----------|-----|------|---------------|--------|------------|
| **Vast.ai** | T4 / RTX 3060 | $0.20–$0.35 | **$144–$252** | Varies (some SG) | Variable |
| **RunPod** | T4 | $0.40 | **$288** | US/EU (low latency via proxy) | Good |
| **GCP** | T4 (preemptible) | ~$0.12 | **~$88** | Singapore | Interruptions |
| **GCP** | T4 (committed) | ~$0.27 | **~$197** | Singapore | Stable |
| **AWS** | T4 (spot) | ~$0.15 | **~$110** | Singapore | Interruptions |

**Best for Malaysia:**
- **GCP T4 committed-use in Singapore** (~$197/mo) — most reliable, low latency from MY
- **Vast.ai** (~$150/mo) — cheapest, but variable reliability
- **Hybrid approach**: Oracle Cloud Free (ARM CPU) for off-peak + GCP spot T4 for peak hours

### What about the 0.8B model?

Skip it. The Intelligence Index of 9 is barely above the old Qwen2.5-1.5B (~8). You'd be rewriting the app to use a model that's only marginally smarter than what you already have. The whole point of the upgrade was getting **meaningfully better answers** — the 0.8B doesn't deliver that for 200-word summaries.

The 0.8B is designed for mobile/edge devices (phones, IoT). Not for a team knowledge assistant.

### Speed presets revisited (with GPU)

With a T4 GPU (~120 tok/s), all presets become fast:

```yaml
presets:
  quick:     { maxTokens: 100, topK: 4 }   # ~1s
  standard:  { maxTokens: 300, topK: 7 }   # ~2.5s  (DEFAULT)
  detailed:  { maxTokens: 500, topK: 9 }   # ~4.2s
```

Even the `detailed` preset comes in under 5 seconds on GPU. The `standard` 200-word answer arrives in ~2.5 seconds — fast enough to feel instant in Slack.

### Phased approach

```
Phase 1 (Dev):     Laptop CPU, Qwen3.5-2B, ~10s responses     → Free
Phase 2 (Team):    Oracle ARM CPU (free), ~12s responses       → Free
Phase 3 (Scale):   GCP/Vast.ai T4 GPU, ~2.5s responses        → ~$150-200/mo
```

If the free Oracle ARM tier feels too slow during Phase 2, jump to Phase 3 early. The code doesn't change — `getLlama()` auto-detects the GPU.

---

## 20. RAG Chunk Size Optimization: 150 Words / 40 Overlap / Top-K 7 / 3072 Context

### Decision Summary

| Setting | Before | After | Rationale |
|---------|--------|-------|-----------|
| **Chunk size** | 200 words | **150 words** | 100% embedding coverage (was ~92.5% with heading) |
| **Chunk overlap** | 50 words | **40 words** | 26.7% ratio (proportionally better) |
| **Top-K** | 5 | **7** | Compensates smaller chunks; 1,050 words total recall |
| **Context window** | 4096 | **3072** | Right-sized; saves ~64 MB KV cache RAM |

### Why this configuration was chosen

Five chunk size options were evaluated across 8 dimensions: token math, embedding quality, retrieval precision/recall, LLM generation quality, CPU speed impact, scalability, content-type fit, and risks.

**Options evaluated:**

| Option | Config | Verdict |
|--------|--------|---------|
| A | 200w / 50 overlap / K=5 | Good but ~7.5% embedding truncation with section headings |
| B | 150w / 40 overlap / K=5 | Fast (23% less context) but 25% less recall |
| **C → chosen** | **150w / 40 overlap / K=7** | **Best balance: 100% embedding, 1,050w recall, ~63% window usage** |
| D | 100w / 25 overlap / K=7 | Too fragmented; procedures split unnaturally |
| E | 250w / 60 overlap / K=4 | ~25% of each chunk invisible to embedding model — non-starter |

### Key constraint: Embedding model token limit

`all-MiniLM-L6-v2` has a **256 token max sequence length**. This is the single most important constraint:

- 200 words ≈ 260 tokens → **exceeds limit** (4 tokens truncated from body)
- With section heading (+15 tokens): 275 tokens → **~7.5% of chunk invisible to retrieval**
- 150 words ≈ 195 tokens + 15 heading = 210 tokens → **100% captured**, zero truncation
- 250 words ≈ 325 tokens + 15 heading = 340 tokens → **~24.7% invisible** — disqualified

### Token budget (3072 window)

```
┌──────────────────────────────────────────────────┐
│              3,072 tokens total                   │
├──────────────────────────────────────────────────┤
│  System prompt (facts-only rules)     ~120 tokens │
│  Question                              ~40 tokens │
│  Context: 7 chunks × 210 tokens     1,470 tokens │
│  Answer (max_tokens)                  300 tokens │
│  Citation markers + formatting         ~30 tokens │
├──────────────────────────────────────────────────┤
│  USED                               1,960 tokens │
│  HEADROOM                           1,112 tokens │
│  Utilization                            63.8%    │
└──────────────────────────────────────────────────┘
```

**Worst case** (long question + long headings): ~2,100 tokens used. Still ~970 tokens headroom. Safe.

**Future flexibility**: 3072 supports up to **top-K=10** with 150-word chunks without any window change.

### Why top-K=7 (not 6 or 8)

The diminishing returns curve for top-K follows this pattern:

| Range | Impact |
|-------|--------|
| K=3-5 | Quality rises steeply — each chunk adds genuinely relevant info |
| K=6-7 | Quality rises moderately — fills gaps, covers edge cases |
| K=8-9 | Quality plateaus — new chunks are marginally relevant |
| K=10+ | Quality may **decrease** — noise drowns out signal |

K=7 was chosen because:

1. **1,050 words recall** — 5% more than the original 5×200=1,000, with better per-chunk precision
2. **+1s latency vs K=6** — minimal speed cost
3. **Tie-breaker chunk** — the 7th chunk is valuable for procedural queries spanning multiple steps
4. **63% window utilization** — healthy balance, not wasteful, not risky
5. **Relevance threshold (L2 < 1.2)** filters out poor matches regardless of K setting

### Comparison to original configuration

| Dimension | Before (200w/K5/4096) | After (150w/K7/3072) | Change |
|-----------|:-----:|:-----:|--------|
| Embedding coverage | 92.5% | **100%** | +7.5% — zero blind spots |
| Retrieval precision | Moderate | **High** | Tighter chunks = focused vectors |
| Total recall | 1,000 words | **1,050 words** | +5% more source material |
| Context tokens | 1,375 | **1,470** | +7% (but better quality) |
| Window utilization | 33.6% | **63.8%** | Much better resource usage |
| KV cache RAM | ~256 MB | **~192 MB** | -64 MB saved |
| Chunks per doc (avg) | 5.3 | **7.3** | 38% more chunks in index |
| Index size @ 5K docs | ~40 MB | **~54 MB** | +14 MB — still manageable |
| CPU latency (est.) | 8-12s | **10-14s** | +1-2s (7 chunks vs 5) |

### Scalability

| Metric | At 2K docs | At 5K docs |
|--------|-----------|-----------|
| Total chunks | ~14,600 | ~36,500 |
| Index size (hnswlib) | ~22 MB | ~54 MB |
| Search time | <3ms | <5ms |
| RAM (index + SQLite) | ~40 MB | ~100 MB |

All metrics are well within the Oracle ARM free tier (24 GB RAM) and laptop constraints.

### When to revisit this configuration

- **Upgrade embedding model** to one with >256 token limit → can increase chunk size
- **Switch to GPU** → can afford larger context, more chunks (K=9-10)
- **Corpus exceeds 10K+ docs** → may need to reduce top-K to maintain precision
- **Users report fragmented answers** → increase chunk size to 180-200 words
- **Users report slow responses** → reduce to K=5-6 for faster context processing

---

## 21. WhatsApp Integration: Not Now, Design For It Later

### Verdict: Slack only for now. But architect for easy multi-platform support.

### Why not WhatsApp now

**1. WhatsApp adds cost, Slack doesn't**

Slack: Your bot sends unlimited messages for free (no per-message fees).
WhatsApp: Meta charges per template message (~$0.02-0.04/message in Malaysia). If 15 people ask 5 questions/day, that's 75 messages × $0.03 = ~$2.25/day = ~$68/month — just for messaging fees, on top of hosting.

Service (user-initiated) messages ARE free within 24 hours, but bot-initiated replies using templates are not.

**2. WhatsApp is harder to set up**

- Requires a Meta Business account + verification (can take days/weeks)
- Need a dedicated phone number for the bot
- Self-hosted API is deprecated — must use Meta's Cloud API
- Message templates need pre-approval from Meta for business-initiated messages
- Rate limits are stricter than Slack

**3. WhatsApp formatting is limited**

Slack has Block Kit (rich formatting, buttons, code blocks, expandable sections). WhatsApp has basic text + bold/italic. Your 200-word answers with citations and source links would look much better in Slack.

**4. Slack is the right tool for company knowledge**

WhatsApp is for personal/customer communication. Slack is where teams work. A knowledge assistant belongs where the work happens — Slack channels, threads, searchable history.

### When WhatsApp WOULD make sense

- If your team primarily communicates via WhatsApp (common in some Malaysian companies)
- If you want to extend Monday to customers (external-facing FAQ bot)
- If field workers/non-desk employees need access without Slack

### How to architect for future multi-platform support

The key is keeping the **Slack layer thin** — all intelligence lives in `src/rag/pipeline.ts`, not in the Slack handlers. The current design already does this:

```
src/slack/commands/ask.ts    → calls pipeline.answerQuestion()
src/slack/events/mention.ts  → calls pipeline.answerQuestion()
```

To add WhatsApp later, you'd just add:
```
src/whatsapp/webhook.ts      → calls pipeline.answerQuestion()
src/whatsapp/formatter.ts    → converts RagResponse to WhatsApp text format
```

No changes to RAG, embedding, LLM, or indexing code. The `RagResponse` type (answer + citations) is platform-agnostic — each platform's formatter converts it to the right message format.

**One small architectural prep**: In Section 4's project structure, the `src/slack/` folder is already isolated. Keep all Slack-specific code there. The `src/rag/` and `src/core/` folders have zero Slack imports — this makes adding WhatsApp (or Teams, or Telegram, or a web API) trivial later.

### Cost comparison for Malaysia (monthly, 15 users)

| Platform | Messaging Cost | Hosting | Total |
|----------|---------------|---------|-------|
| **Slack only** | Free | $0-200 | **$0-200** |
| Slack + WhatsApp | ~$68/mo (WhatsApp) | $0-200 | **$68-268** |
| WhatsApp only | ~$68/mo | $0-200 | **$68-268** |

### Summary

Start with Slack only. The architecture already supports adding WhatsApp later with ~2 new files and zero changes to the core RAG engine. Revisit when there's a clear need (field workers, customer-facing use, WhatsApp-first team culture).

---

## Files Summary

**Total new files**: ~30 TypeScript files (vs 80+ Python files — much leaner)

| Category | Files | Key Dependencies |
|---|---|---|
| Entry + Config | 2 | dotenv, yaml |
| Slack Layer | 8 | @slack/bolt |
| RAG Pipeline | 3 | — |
| Core Services | 5 | node-llama-cpp, @huggingface/transformers, hnswlib-node, better-sqlite3, pdf-parse, mammoth |
| Indexing | 4 | chokidar, node-cron, axios |
| Utilities | 3 | pino, path |
| Tests | ~8 | vitest |
| Config/Deploy | 5 | Docker |
