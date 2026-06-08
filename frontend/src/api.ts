// api.ts — tiny client for the backend's SSE endpoints.
//
// The backend streams Server-Sent Events over a POST response. The browser's
// EventSource only does GET, so we read the streamed body with fetch + a
// ReadableStream reader and parse the `data: {...}` blocks ourselves.

const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export interface ProductCard {
  id: number;
  title: string;
  url: string;
  price_cents: number | null;
  currency: string | null;
  in_stock: boolean | null;
  rating_avg: number | null;
  rating_count: number | null;
  role: "anchor" | "alternative";
  highlights: string[];
  verified_at: string | null; // ISO timestamp of the last crawl → "verified live" badge
}

export interface WebInsights {
  text: string;
  sources: { url: string; title: string }[];
}

// Mirrors the events routes.ts / rag.ts emit. The answer now streams:
//   meta  → intent + product cards (render immediately)
//   delta → incremental answer text (append for the typewriter effect)
//   web   → "what the web says" (arrives once the parallel search resolves)
export type ChatEvent =
  | { type: "progress"; phase: string; message: string }
  | { type: "meta"; intent: string; products: ProductCard[] }
  | { type: "delta"; text: string }
  | { type: "web"; webInsights: WebInsights | null }
  | { type: "error"; message: string }
  | { type: "done" };

/**
 * postChat — POST { query, url } and invoke onEvent for each streamed event.
 * Resolves when the stream closes.
 */
export async function postChat(
  body: { query: string; url?: string },
  onEvent: (e: ChatEvent) => void
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    onEvent({ type: "error", message: `Cannot reach the backend at ${API}. Is it running?` });
    return;
  }

  if (!res.ok || !res.body) {
    onEvent({ type: "error", message: `Request failed (HTTP ${res.status}).` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE messages are separated by a blank line. Keep the trailing partial.
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      try {
        onEvent(JSON.parse(json) as ChatEvent);
      } catch {
        // ignore a malformed frame
      }
    }
  }
}
