// ai.ts — the single chokepoint for every OpenAI call.
//
// Golden rule #3: ALL model calls go through here. Nothing else in the codebase
// imports the `openai` SDK directly. Callers use `embed()` and `complete()` only,
// so swapping providers (or mocking in tests) later touches just this one file
// instead of the whole pipeline.
//
// Connections:
//   - ingest.ts   → embed()   on semantic documents before storing vectors
//   - retrieve.ts → embed()   on the shopper's query for the ANN search
//   - rag.ts      → complete() with the grounding prompt + retrieved facts

import OpenAI from "openai";

// Model + dimension choices live in one obvious place. Anyone changing the
// embedding model must also keep EMBEDDING_DIM in sync with the vector(1536)
// column in migrations/001_init.sql — otherwise inserts will fail.
const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM = 1536;
const CHAT_MODEL = "gpt-4o";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  // Fail loud and early — a missing key would otherwise surface deep inside an
  // ingest run or a chat request as a confusing 401.
  throw new Error("OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.");
}

// One shared client for the whole process. The SDK handles connection reuse.
const openai = new OpenAI({ apiKey });

/**
 * embed — turn an array of strings into an array of 1536-dim vectors.
 *
 * Array-in / array-out because ingest embeds many chunks at once; a caller with
 * a single string just passes `[text]`. The OpenAI endpoint accepts an array in
 * one request, so this is a single batched call (the design doc §11 asks for
 * batching to keep cost/latency low).
 *
 * NOTE: for very large inputs you'd chunk into sub-batches (the API caps tokens
 * per request). For the POC one batch is fine; add chunking here if ingest grows.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  // Guard the empty case so we never send a malformed request.
  if (texts.length === 0) return [];

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });

  // The API guarantees results in the same order as the input, but be explicit
  // and sort by index so we never silently misalign vectors with their source text.
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

/** Options for a single GPT-4o completion. */
export interface CompleteOptions {
  /** System prompt — the strict grounding rules (rag.ts supplies this). */
  system: string;
  /** User message — the question plus any grounded catalog context. */
  user: string;
  /** Sampling temperature. Low default for factual, grounded answers. */
  temperature?: number;
  /** When true, ask the model to return a JSON object (for structured cards). */
  json?: boolean;
}

/**
 * complete — run one GPT-4o chat completion and return the assistant text.
 *
 * Returns a plain string so callers never touch the SDK's nested response shape.
 * `json: true` flips on response_format so rag.ts can request structured product
 * cards (design doc §13) without each caller re-specifying the option.
 */
export async function complete(opts: CompleteOptions): Promise<string> {
  const { system, user, temperature = 0.2, json = false } = opts;

  const response = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // Only set response_format when JSON is requested; leaving it unset keeps
    // normal conversational answers as plain text.
    ...(json ? { response_format: { type: "json_object" as const } } : {}),
  });

  // There is always at least one choice; default to an empty string rather than
  // throwing, so a rare empty completion degrades gracefully instead of crashing.
  return response.choices[0]?.message?.content ?? "";
}

// Model with built-in web search (reuses our OpenAI key — no separate search API).
const SEARCH_MODEL = "gpt-4o-search-preview";

export interface WebInsights {
  text: string;
  sources: { url: string; title: string }[];
}

/**
 * webInsights — search the public web for buyer opinions / general context about
 * a query, returning a short summary + source citations.
 *
 * IMPORTANT: this is the "what people say" layer. It must NEVER be treated as
 * catalog truth — price/stock always come from our SQL. The system prompt below
 * explicitly forbids stating prices/stock so the two layers stay separate.
 */
export async function webInsights(query: string): Promise<WebInsights> {
  const response = await openai.chat.completions.create({
    model: SEARCH_MODEL,
    // The search-preview model does its own web search; temperature isn't supported.
    web_search_options: {},
    messages: [
      {
        role: "system",
        content:
          "You summarize what real buyers and reviewers across the web say about the kind " +
          "of product the user is asking about. Return 3-4 short bullet points of practical " +
          "buying insight (durability, comfort, common complaints, tips) — one insight per " +
          "bullet. Format each bullet on its own line starting with '- ' (a hyphen and a " +
          "space); do NOT write paragraphs. Do NOT state specific prices or stock — those " +
          "come from the retailer, not you. Be concise and neutral.",
      },
      { role: "user", content: query },
    ],
  } as any);

  const msg = response.choices[0]?.message as any;
  const text = msg?.content ?? "";
  const sources =
    (msg?.annotations ?? [])
      .filter((a: any) => a.type === "url_citation" && a.url_citation)
      .map((a: any) => ({ url: a.url_citation.url, title: a.url_citation.title || a.url_citation.url })) ?? [];
  // De-dupe sources by URL.
  const seen = new Set<string>();
  const unique = sources.filter((s: { url: string }) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
  return { text, sources: unique.slice(0, 4) };
}
