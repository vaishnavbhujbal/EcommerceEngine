// index.ts — the backend entrypoint: load env, build the Express app, expose
// /health, and start listening.
//
// IMPORTANT: the dotenv side-effect import below MUST stay the first import.
// ESM evaluates imports in source order, and db.ts / ai.ts throw at import-time
// when their env vars are missing. Loading .env first means those guards see the
// real values instead of failing on an empty process.env.
import "dotenv/config";

import express from "express";
import cors from "cors";

import { pool } from "./db.js";
import { router } from "./routes.js";

const app = express();

// CORS: in production only the deployed frontend should call this API. We read
// the allowed origin from FRONTEND_ORIGIN (the Vercel URL on Render). If it's
// unset (local dev), allow all origins so the Vite dev server just works.
// Trim + treat an empty/whitespace value as "unset" — otherwise an empty
// FRONTEND_ORIGIN="" would configure CORS with an empty origin and block the
// browser. `|| undefined` makes "" fall through to `?? true` (allow all in dev).
const frontendOrigin = process.env.FRONTEND_ORIGIN?.trim() || undefined;
app.use(cors({ origin: frontendOrigin ?? true }));

// Parse JSON request bodies (the /ingest and /chat routes will POST JSON later).
app.use(express.json());

// GET /health — liveness + DB reachability in one check.
//
// CLAUDE.md build order says to verify the DB connection works before moving on,
// so this doesn't just return "ok" blindly: it runs a trivial `SELECT 1` against
// Supabase and only reports the DB as "up" if that round-trip succeeds.
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "up" });
  } catch (err) {
    // Surface the failure as 503 (service unavailable) with the error message,
    // so a misconfigured DATABASE_URL is obvious the moment we hit /health.
    console.error("Health check DB query failed:", err);
    res.status(503).json({ status: "degraded", db: "down" });
  }
});

// Engine endpoints: POST /ingest and POST /chat (both SSE-streamed).
app.use(router);

// Render injects PORT dynamically; fall back to 4000 for local dev.
const port = Number(process.env.PORT) || 4000;

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
