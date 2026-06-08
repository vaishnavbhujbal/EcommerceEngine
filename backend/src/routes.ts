// routes.ts — HTTP surface: POST /ingest and POST /chat, both streamed over SSE.
//
// We stream Server-Sent Events so the frontend can show live progress (crawling,
// generating AEO/GEO, embedding, composing answer) instead of a frozen spinner.
// Each event is a JSON object with a `type`: "progress" | "result" | "error" | "done".
//
// Note: these are POST + SSE (not the browser's GET-only EventSource). The frontend
// reads the streamed body with fetch() + a ReadableStream reader.

import { Router, type Response } from "express";
import { answer } from "./rag.js";
import { ingestUrl, type ProgressFn } from "./ingest.js";

export const router = Router();

/** Set SSE response headers and flush them so the stream opens immediately. */
function initSse(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Disable proxy buffering (nginx / Render) so events arrive in real time.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

/** Write one SSE message. */
function send(res: Response, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /chat — { query, url? } → grounded streamed answer
// ─────────────────────────────────────────────────────────────────────────────

router.post("/chat", async (req, res) => {
  const { query, url } = req.body ?? {};
  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "query (string) is required" });
    return;
  }

  initSse(res);
  // answer() streams its own typed events (meta → delta… → web) through emit.
  const emit = (event: Record<string, unknown>) => send(res, event);

  try {
    const anchorUrl = typeof url === "string" && url.trim() ? url.trim() : undefined;
    await answer(query, anchorUrl, emit);
  } catch (err) {
    console.error("/chat error:", err);
    send(res, { type: "error", message: (err as Error).message });
  } finally {
    send(res, { type: "done" });
    res.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /ingest — { url } → streamed crawl → AEO/GEO → embed → store
// ─────────────────────────────────────────────────────────────────────────────

router.post("/ingest", async (req, res) => {
  const { url } = req.body ?? {};
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "url (string) is required" });
    return;
  }

  initSse(res);
  const onProgress: ProgressFn = (e) => send(res, { type: "progress", ...e });

  try {
    const products = await ingestUrl(url.trim(), onProgress);
    send(res, { type: "result", products });
  } catch (err) {
    console.error("/ingest error:", err);
    send(res, { type: "error", message: (err as Error).message });
  } finally {
    send(res, { type: "done" });
    res.end();
  }
});
