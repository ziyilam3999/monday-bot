/**
 * The FUZZY half of the NL→JQL determinism seam (#1332).
 *
 * `nlFilterMapper.map(question, vocab) → StructuredFilter`: the LLM is HANDED the
 * legal vocabulary (the live symptom slugs + whatever feature/flow slugs the
 * gitignored catalog currently holds) at RUNTIME and must answer ONLY in that
 * vocabulary, as JSON matching `StructuredFilter`. The PURE `buildJqlFromFilter`
 * then turns that filter into the JQL string — no LLM in the builder.
 *
 * Classification-shape → Haiku tier (the `ANTHROPIC_MODEL` default), temperature 0
 * for a stable mapping (mirrors `src/llm/generate.ts`).
 *
 * Degrades gracefully + never throws into the pipeline:
 *   - `MONDAY_TEST_MODE=1` → a DETERMINISTIC stub filter (the question routed
 *     through the pure `categorizeDefect` to pick ONE symptom), so CLI/AC runs
 *     need NO creds and make ZERO network calls.
 *   - malformed / empty / non-JSON model output, or a thrown client → an EMPTY
 *     filter (all axes `[]`), so the pipeline degrades to "no JQL / show usage".
 *
 * `extraStatus` is OPERATOR-ONLY: the parser deliberately IGNORES any
 * `extraStatus` field in the model's JSON — the LLM must never inject a raw
 * status clause (the SHOULD-fix folded into the plan).
 */
import { getClient } from "../llm/anthropicClient";
import { categorizeDefect } from "../triage/categorizeDefect";
import { LabelVocab, StructuredFilter } from "./jqlFromFilter";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_TOKENS = 512;

/** The injectable message-creating call (production wraps `getClient()`). */
export type MessagesCreate = (req: {
  model: string;
  max_tokens: number;
  temperature: number;
  system: string;
  messages: Array<{ role: string; content: string }>;
}) => Promise<{ content: Array<{ type: string; text?: string }> }>;

export interface NlFilterMapper {
  map(question: string, vocab: LabelVocab): Promise<StructuredFilter>;
}

export interface LlmFilterMapperDeps {
  /** Injected for tests (a fake returning canned JSON). Defaults to `getClient()`. */
  createMessage?: MessagesCreate;
  /** Model override; defaults to the Haiku-tier `ANTHROPIC_MODEL`. */
  model?: string;
}

function isTestMode(): boolean {
  return process.env.MONDAY_TEST_MODE === "1";
}

/** A filter with every axis empty — the safe degrade target. */
export function emptyFilter(): StructuredFilter {
  return { symptoms: [], features: [], flows: [], projects: [] };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * Extract the first balanced-ish JSON object substring (`{ ... }`) from the raw
 * model text — tolerant of code fences / chatter around the JSON.
 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

/**
 * Parse model text → `StructuredFilter`. Defensive: any failure (no JSON, bad
 * JSON, wrong shape) yields an EMPTY filter. NEVER reads `extraStatus` from the
 * model output (operator-only).
 */
export function parseFilterJson(raw: string): StructuredFilter {
  if (typeof raw !== "string" || raw.trim().length === 0) return emptyFilter();
  const jsonStr = extractJsonObject(raw);
  if (jsonStr === null) return emptyFilter();
  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return emptyFilter();
  }
  if (!obj || typeof obj !== "object") return emptyFilter();
  const o = obj as Record<string, unknown>;
  return {
    symptoms: toStringArray(o.symptoms),
    features: toStringArray(o.features),
    flows: toStringArray(o.flows),
    projects: toStringArray(o.projects),
    // extraStatus deliberately NOT read — operator-only, never LLM-emitted.
  };
}

/** Deterministic offline stub: route the question through the pure categorizer. */
function stubFilter(question: string): StructuredFilter {
  const { category } = categorizeDefect({ summary: question ?? "" });
  return { symptoms: [category], features: [], flows: [], projects: [] };
}

function extractText(response: { content?: unknown }): string {
  if (!response || !Array.isArray(response.content)) return "";
  return (response.content as Array<{ type?: string; text?: unknown }>)
    .filter((b) => b.type === "text")
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("")
    .trim();
}

/** Build the system prompt embedding the legal vocabulary (runtime catalog). */
function buildSystemPrompt(vocab: LabelVocab): string {
  const symptoms = [...vocab.symptoms].sort();
  const features = [...vocab.featureIds].map((id) => id.replace(/^feature-/, "")).sort();
  const flows = [...vocab.flowIds].map((id) => id.replace(/^flow-/, "")).sort();
  return [
    "You translate an English question about software defects into a JSON filter.",
    "Answer with a SINGLE JSON object and NOTHING else (no prose, no code fences).",
    'Shape: {"symptoms":[],"features":[],"flows":[],"projects":[]}',
    "Use ONLY values from these allowed lists; emit an empty array for an axis you can't fill.",
    `Allowed symptoms: ${symptoms.length > 0 ? symptoms.join(", ") : "(none)"}`,
    `Allowed features: ${features.length > 0 ? features.join(", ") : "(none)"}`,
    `Allowed flows: ${flows.length > 0 ? flows.join(", ") : "(none)"}`,
    "projects is a list of UPPERCASE Jira project keys mentioned in the question (e.g. DEMO); empty if none.",
    "Do NOT invent values outside the allowed lists. Do NOT include any other keys.",
  ].join("\n");
}

function defaultCreateMessage(): MessagesCreate {
  return async (req) => {
    const client = getClient();
    return (await client.messages.create(req as never)) as unknown as {
      content: Array<{ type: string; text?: string }>;
    };
  };
}

/**
 * Production mapper. In test mode returns the deterministic stub; otherwise calls
 * the (injected or default) LLM client and parses its JSON defensively.
 */
export function buildLlmFilterMapper(deps: LlmFilterMapperDeps = {}): NlFilterMapper {
  const model = deps.model ?? MODEL;
  return {
    async map(question: string, vocab: LabelVocab): Promise<StructuredFilter> {
      if (isTestMode()) return stubFilter(question);
      const create = deps.createMessage ?? defaultCreateMessage();
      try {
        const response = await create({
          model,
          max_tokens: MAX_TOKENS,
          temperature: 0,
          system: buildSystemPrompt(vocab),
          messages: [{ role: "user", content: question }],
        });
        return parseFilterJson(extractText(response));
      } catch {
        // No creds / network error / malformed response → degrade to empty.
        return emptyFilter();
      }
    },
  };
}
