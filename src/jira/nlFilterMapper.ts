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

/** A non-empty trimmed string, else `undefined` (so the optional key is omitted). */
function toOptionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
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
  const filter: StructuredFilter = {
    symptoms: toStringArray(o.symptoms),
    features: toStringArray(o.features),
    flows: toStringArray(o.flows),
    projects: toStringArray(o.projects),
    // extraStatus deliberately NOT read — operator-only, never LLM-emitted.
  };
  // Optional single-value axes: only ADD the key when present + non-empty, so a
  // filter with neither still `toEqual`s `emptyFilter()` (degrade-path contract).
  // The closed-enum table in the builder is the injection guard — we pass the
  // raw token through verbatim (unknown tokens are dropped THERE, not here).
  const priority = toOptionalString(o.priority);
  if (priority !== undefined) filter.priority = priority;
  const recency = toOptionalString(o.recency);
  if (recency !== undefined) filter.recency = recency;
  return filter;
}

/**
 * Closed PRIORITY vocabulary — an English signal → ONE canonical token the pure
 * builder's `PRIORITY_FRAGMENTS` table knows. First match wins.
 */
const PRIORITY_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(critical|sev\s?0|blocker)\b/i, "critical"],
  [/\b(urgent|asap)\b/i, "urgent"],
  [/\b(high[-\s]?priority|highest|top[-\s]?priority|p0|p1|important)\b/i, "high"],
];

/**
 * Closed RECENCY vocabulary — an English signal → ONE canonical token the pure
 * builder's `RECENCY_FRAGMENTS` table knows. First match wins.
 */
const RECENCY_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(this week|past week|last 7 days)\b/i, "this-week"],
  [/\b(last release|previous release|prior release)\b/i, "last-release"],
  [/\b(latest|recently|recent|newest|today)\b/i, "latest"],
];

/** The allowed closed-enum tokens, surfaced to the production LLM in the prompt. */
const PRIORITY_TOKENS = ["high", "critical", "urgent"] as const;
const RECENCY_TOKENS = ["this-week", "last-release", "latest"] as const;

function extractPriorityToken(text: string): string | undefined {
  for (const [re, token] of PRIORITY_SIGNALS) if (re.test(text)) return token;
  return undefined;
}

function extractRecencyToken(text: string): string | undefined {
  for (const [re, token] of RECENCY_SIGNALS) if (re.test(text)) return token;
  return undefined;
}

/**
 * The SHARED deterministic extraction — pure, zero-I/O. Returns ONLY axes backed
 * by a GENUINE signal:
 *   - a NON-FALLBACK symptom (`categorizeDefect` matchedRule !== "fallback"),
 *   - a recognised priority token,
 *   - a recognised recency token.
 * If the question yields NONE of these (categorizer lands in `other`/fallback and
 * there is no priority/recency word), it returns `emptyFilter()` UNCHANGED — so a
 * fallback-only question stays empty (preserves the "show usage" degrade UX and
 * safe composition with the orthogonal project-scoping lane). Used by BOTH the
 * test-mode stub AND the empty/error floor, so the two share ONE notion of "genuine".
 */
export function deterministicSignalFilter(question: string): StructuredFilter {
  const text = question ?? "";
  const filter = emptyFilter();
  const { category, matchedRule } = categorizeDefect({ summary: text });
  if (matchedRule !== "fallback") filter.symptoms = [category];
  const priority = extractPriorityToken(text);
  if (priority !== undefined) filter.priority = priority;
  const recency = extractRecencyToken(text);
  if (recency !== undefined) filter.recency = recency;
  return filter;
}

/** Is this filter all-empty (every axis blank, no priority/recency/extraStatus)? */
function isEmptyFilter(f: StructuredFilter): boolean {
  return (
    (f.symptoms?.length ?? 0) === 0 &&
    (f.features?.length ?? 0) === 0 &&
    (f.flows?.length ?? 0) === 0 &&
    (f.projects?.length ?? 0) === 0 &&
    f.priority === undefined &&
    f.recency === undefined &&
    (f.extraStatus === undefined || f.extraStatus.trim().length === 0)
  );
}

/**
 * The GATED deterministic floor: when the mapped filter is all-empty (unmapped
 * words OR a model error / no-creds degrade), fall back to the shared genuine-
 * signal extraction. If that finds NO genuine signal it returns `emptyFilter()`
 * unchanged — the floor does NOT fire, the empty→"show usage" path is preserved.
 */
function applyDeterministicFloor(question: string, filter: StructuredFilter): StructuredFilter {
  if (!isEmptyFilter(filter)) return filter;
  return deterministicSignalFilter(question);
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
  // #1385 — lean family/bucket slugs the LLM may ALSO echo (a family name returns
  // the WHOLE family). Names come from the injected vocab at runtime (PUBLIC repo:
  // no real bucket names are hardcoded here). Empty/absent → "(none)", a no-op.
  const featureFamilies = [...(vocab.featureBucketIds ?? [])]
    .map((id) => id.replace(/^feature-/, ""))
    .sort();
  const flowFamilies = [...(vocab.flowBucketIds ?? [])].map((id) => id.replace(/^flow-/, "")).sort();
  return [
    "You translate an English question about software defects into a JSON filter.",
    "Answer with a SINGLE JSON object and NOTHING else (no prose, no code fences).",
    'Shape: {"symptoms":[],"features":[],"flows":[],"projects":[],"priority":"","recency":""}',
    "Use ONLY values from these allowed lists; emit an empty array (or an empty string for priority/recency) for an axis you can't fill.",
    `Allowed symptoms: ${symptoms.length > 0 ? symptoms.join(", ") : "(none)"}`,
    "Map generic symptom words to the closest allowed symptom slug — e.g. crash/freeze/hang/error/bug/exception → crash-error; cannot/can't/unable/fails/blocked → cannot-complete; wrong/incorrect/mismatch/duplicate → data-incorrect; missing/blank/empty/not shown → missing-element; layout/button/font/colour/UI → display-ui; navigate/redirect/back button → navigation-flow; slow/lag/delay/timeout → performance.",
    `Allowed features: ${features.length > 0 ? features.join(", ") : "(none)"}`,
    `Allowed feature families: ${featureFamilies.length > 0 ? featureFamilies.join(", ") : "(none)"}`,
    `Allowed flows: ${flows.length > 0 ? flows.join(", ") : "(none)"}`,
    `Allowed flow families: ${flowFamilies.length > 0 ? flowFamilies.join(", ") : "(none)"}`,
    "A family/bucket name on the feature or flow axis returns the WHOLE family — use a family name only when the question names a broad area rather than one specific feature/flow; otherwise prefer the specific name. Do NOT name the SAME concept on both the feature and flow axes — pick the one axis that fits.",
    "projects is a list of UPPERCASE Jira project keys mentioned in the question (e.g. DEMO); empty if none.",
    `priority is exactly ONE token from [${PRIORITY_TOKENS.join(", ")}] when the question implies priority (high priority/critical/urgent); empty string otherwise.`,
    `recency is exactly ONE token from [${RECENCY_TOKENS.join(", ")}] when the question implies a time window (this week/last release/latest); empty string otherwise.`,
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
      // Test mode short-circuits to the shared deterministic extraction (no client).
      if (isTestMode()) return deterministicSignalFilter(question);
      const create = deps.createMessage ?? defaultCreateMessage();
      let filter: StructuredFilter;
      try {
        const response = await create({
          model,
          max_tokens: MAX_TOKENS,
          temperature: 0,
          system: buildSystemPrompt(vocab),
          messages: [{ role: "user", content: question }],
        });
        filter = parseFilterJson(extractText(response));
      } catch {
        // No creds / network error / malformed response → degrade to empty.
        filter = emptyFilter();
      }
      // GATED floor: only fires when the mapped filter is empty AND the question
      // carries a genuine signal; otherwise returns the empty filter unchanged.
      return applyDeterministicFloor(question, filter);
    },
  };
}
