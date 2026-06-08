# CHECKPOINT — Discovery Engine

_Last updated: 2026-06-07_

A running log of what's built, how it works, and what's left. Read this top-to-bottom
to get back up to speed without re-reading every file.

---

## 1. What this project is

An AI-powered ecommerce **discovery engine** (POC). Given a shopper **prompt + a store URL**,
it crawls the page with a real headless browser, structures the catalog (AEO + GEO),
embeds the semantic content, and answers with a **grounded, conversion-oriented** response —
live price/stock from SQL, citations, cross-sell/upsell — to beat a generic ChatGPT answer
for that specific catalog.

Full spec: `docs/POC_Technical_Design.md` · Local setup: `docs/SETUP.md` · Rules: `CLAUDE.md`

---

## 2. Current status — at a glance

| Area | Status |
|---|---|
| Backend (9 files) | ✅ Built & verified end-to-end against IKEA |
| Frontend (React/Vite) | ✅ Built, wired to real `/ingest` + `/chat` SSE endpoints |
| Database (Supabase + pgvector) | ✅ Schema migrated, working |
| Git repository | ✅ Initialized + pushed to GitHub |
| Deploy: Render (backend) | ⏳ Not started (plan ready) |
| Deploy: Vercel (frontend) | ⏳ Not started (plan ready) |

**GitHub:** https://github.com/vaishnavbhujbal/EcommerceEngine
**Branch:** `main` · **Initial commit:** `f491b38`

---

## 3. Stack

- **Backend:** Node.js + Express + TypeScript, run directly with `tsx` (no build step)
- **Frontend:** React + TypeScript + Vite + Tailwind v4
- **Headless browser:** Playwright (Chromium)
- **Database:** Supabase (Postgres + pgvector), via `DATABASE_URL`
- **LLM + embeddings:** OpenAI (GPT-4o + `text-embedding-3-small`), isolated behind `ai.ts`

---

## 4. How it works — the data flow

```
                         ┌──────────────────────────── backend/src ────────────────────────────┐
Browser (Vercel)         │                                                                      │
  prompt + URL  ──POST──►│  routes.ts ──► rag.ts ──► retrieve.ts ──► db.ts ──► Supabase (SQL)    │
   (SSE stream) ◄────────│     │            │            │                                       │
                         │     │            │            └──► ai.embed()  ─┐                      │
                         │     └─/ingest─► ingest.ts ─► crawler.ts        ├─► OpenAI             │
                         │                     │         (Playwright)      │                      │
                         │                     └──► ai.embed()  ───────────┘                      │
                         │                          ai.complete() / webInsights()                │
                         └──────────────────────────────────────────────────────────────────────┘
```

### Backend files (build order mirrors the data flow)

1. **`db.ts`** — single `pg` Pool for the whole app. Enables SSL automatically for Supabase
   hosts. Throws at import if `DATABASE_URL` is missing (fail loud, fail early).
2. **`ai.ts`** — the **only** file that imports the OpenAI SDK (Golden Rule #3). Exposes
   `embed()` (batched 1536-dim vectors), `complete()` (GPT-4o, optional JSON mode), and
   `webInsights()` (web-search model for "what buyers say"). Throws if `OPENAI_API_KEY` missing.
3. **`index.ts`** — Express entrypoint. Loads `dotenv/config` **first** (must stay first import),
   configures CORS from `FRONTEND_ORIGIN` (allow-all in dev when unset), exposes `GET /health`
   (runs `SELECT 1` to prove the DB is reachable), mounts the router, listens on `PORT`.
4. **`migrations/001_init.sql`** — schema (products, variants, reviews, embeddings,
   related_products). `CREATE EXTENSION vector`, `vector(1536)` embedding column.
5. **`crawler.ts`** — Playwright Chromium. Lazily launches **one** shared headless browser,
   renders a PDP, extracts JSON-LD + DOM. `closeBrowser()` frees the process after a run
   (matters on a 512 MB host).
6. **`sites.ts`** — per-site crawl hints/selectors (e.g. IKEA) so the crawler knows where to look.
7. **`ingest.ts`** — orchestrates: crawl → build AEO/GEO documents → `embed()` → store vectors
   + SQL rows. Streams progress.
8. **`retrieve.ts`** — hybrid retrieval: embed the query → vector ANN search → SQL filters →
   **join live price/stock at answer-time** (never embedded — Golden Rule #2).
9. **`rag.ts`** — intent router → assemble grounded context → `complete()` → recommendation
   engine (anchor + alternatives). Never invents price/SKU/stock (Golden Rule #1).
10. **`routes.ts`** — HTTP surface. `POST /ingest` and `POST /chat`, both streamed as
    **Server-Sent Events** (`data: {type, ...}\n\n`) so the UI shows live pipeline progress.

### Frontend files

- **`api.ts`** — reads `VITE_API_URL`; POSTs to `/chat` and `/ingest` and parses the SSE
  stream manually with `fetch` + a `ReadableStream` reader (EventSource is GET-only).
- **`App.tsx`** — single-panel prompt+URL UI; renders pipeline progress, the grounded answer,
  product cards (price/stock/rating), and web-insight citations.
- **`main.tsx` / `index.css`** — React mount + `@import "tailwindcss";` (Tailwind v4 Vite plugin).

---

## 5. The golden rules (do not break)

1. **Never invent catalog facts.** Price, SKU, stock come only from SQL/retrieval.
2. **Semantic data in vectors; volatile data in SQL.** Embed descriptions/reviews/FAQs/specs/GEO;
   **never** embed price or stock — join them live so answers are always current.
3. **All model calls go through `ai.ts`** (`embed()` + `complete()`), so providers swap cleanly.
4. **Keep it simple.** Flat files, one concern each.

---

## 6. Environment variables

### Backend (`backend/.env` locally; set on Render in prod)
| Var | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Postgres. **In prod use the Session Pooler string (IPv4, port 5432)** — the direct connection is IPv6-only and Render can't reach it. |
| `OPENAI_API_KEY` | Embeddings + GPT-4o + web-search model. |
| `PORT` | Express port (Render injects this; local default 4000). |
| `FRONTEND_ORIGIN` | Allowed CORS origin = the Vercel URL (unset = allow all, for dev). |

### Frontend (`frontend/.env` locally; set on Vercel in prod)
| Var | Purpose |
|---|---|
| `VITE_API_URL` | Base URL of the backend (Render URL in prod; `http://localhost:4000` in dev). |

---

## 7. Deployment — done vs remaining

### ✅ Done
- `git init` → commit `f491b38` → pushed to `origin/main`.
- Verified excluded from git: all `node_modules/`, `backend/.env`, `frontend/dist/`, `.claude/`.

### ⏳ Remaining (plan agreed)
**Phase 1 — code prep (one file at a time):**
1. `backend/package.json` — move `tsx` to `dependencies` (so `npm start` works when
   `NODE_ENV=production`); add `"engines": { "node": ">=20" }`.
2. Root `.gitignore` — `node_modules/`, `.env`, `dist/`, `*.log`.
3. `frontend/.gitignore` — add `.env` (Vercel env var supplies the prod value).
4. `render.yaml` (optional) — encode the backend service for near-one-click setup.

**Phase 2 — Render (backend), native Node runtime:**
- New Web Service → repo → **Root Directory: `backend`**
- Build: `npm install && npx playwright install --with-deps chromium`
- Start: `npm start` · Health Check Path: `/health`
- Env vars: `DATABASE_URL` (Session Pooler), `OPENAI_API_KEY`, `FRONTEND_ORIGIN`, `NODE_VERSION=20`

**Phase 3 — Vercel (frontend):**
- Import repo → **Root Directory: `frontend`** → framework auto-detects Vite
- Build `npm run build` · Output `dist`
- Env var: `VITE_API_URL` = Render backend URL

**Phase 4 — close the loop (chicken-and-egg):**
Deploy backend → copy URL → set `VITE_API_URL` on Vercel → deploy frontend → copy URL →
set `FRONTEND_ORIGIN` on Render (auto-redeploys) → hit `/health` → run a real chat.

### ⚠️ Known risks
1. **Playwright on Render native:** `--with-deps` runs `apt-get`, which Render's native build
   may block (no root). **Fallback if Chromium won't launch:** Dockerfile from the official
   Playwright image (`mcr.microsoft.com/playwright`).
2. **Render free tier:** 512 MB RAM (Chromium is tight) + spins down after ~15 min idle →
   first request after is slow (~50s + crawl). Fine for a demo; expect a cold start.

---

## 8. Run it locally (quick reference)

```bash
# backend
cd backend && npm install && npx playwright install chromium
# put DATABASE_URL + OPENAI_API_KEY in backend/.env
npm run dev          # → http://localhost:4000/health

# frontend (separate terminal)
cd frontend && npm install
npm run dev          # → http://localhost:5173
```
