# Discovery Engine — Setup Guide

A clean, minimal monorepo. One concern per file, no deep nesting. Get it running end-to-end first, then fill in the logic.

---

## Project structure

```
discovery-engine/
├── docker-compose.yml          # Postgres + pgvector
├── README.md
│
├── backend/
│   ├── .env                    # secrets (gitignored)
│   ├── .env.example
│   ├── package.json
│   ├── tsconfig.json
│   ├── migrations/
│   │   └── 001_init.sql        # schema (paste from design doc §6 + related_products)
│   └── src/
│       ├── index.ts            # Express entry + /health
│       ├── db.ts               # pg pool
│       ├── ai.ts               # LLM + embeddings (provider abstraction)
│       ├── crawler.ts          # Playwright: render + extract one PDP
│       ├── ingest.ts           # crawl → AEO/GEO → embed → store
│       ├── retrieve.ts         # hybrid retrieval (vector + SQL + live join)
│       ├── rag.ts              # intent router → ground → answer → recommend
│       └── routes.ts           # POST /ingest, POST /chat  (SSE)
│
└── frontend/
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    └── src/
        ├── main.tsx
        ├── index.css           # @import "tailwindcss";
        ├── App.tsx
        ├── api.ts              # fetch + SSE helpers
        └── components/
            ├── SearchBox.tsx   # prompt + URL inputs
            ├── Pipeline.tsx    # live tracing steps
            ├── Answer.tsx      # grounded answer + sidebar
            └── ProductCard.tsx # price/stock/promo + add to cart
```

**Why this shape:** the backend `src/` is 8 flat files that mirror the data flow (crawl → ingest → retrieve → rag → routes). You can read the whole app top to bottom. No premature folders.

---

## Prerequisites

- **Node.js 20+** — check with `node -v` (Tailwind v4 / Vite need a modern Node).
- **Docker Desktop** — the easiest way to run Postgres with pgvector.
- **An OpenAI API key** — or skip it and use Ollama (open-source path, noted at the end).

---

## Step 0 — Create the workspace

```bash
mkdir discovery-engine && cd discovery-engine
```

---

## Step 1 — Database (Postgres + pgvector)

Create `docker-compose.yml` in the root:

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: discovery
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

Start it:

```bash
docker compose up -d
```

**Verify:** `docker compose ps` shows the `db` container as running/healthy. The `pgvector/pgvector` image already has the `vector` extension available — your migration just needs `CREATE EXTENSION IF NOT EXISTS vector;`.

---

## Step 2 — Backend

```bash
mkdir backend && cd backend
npm init -y

# runtime deps
npm install express cors dotenv pg openai playwright
# dev deps
npm install -D typescript tsx @types/node @types/express @types/cors @types/pg

npx tsc --init
npx playwright install chromium     # downloads the headless browser binary
```

In `backend/package.json`, set the scripts and module type:

```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts"
  }
}
```

Create `backend/.env.example` (and copy it to `.env` with your real key):

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/discovery
OPENAI_API_KEY=sk-your-key-here
PORT=4000
```

```bash
cp .env.example .env     # then edit .env and paste your key
```

Create the three starter files so you have a running, verifiable backend:

`backend/src/db.ts`
```ts
import { Pool } from "pg";
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

`backend/src/ai.ts` — the provider abstraction (swap models here, nowhere else)
```ts
import OpenAI from "openai";
const openai = new OpenAI();   // reads OPENAI_API_KEY from env

export async function embed(text: string): Promise<number[]> {
  const r = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return r.data[0].embedding;
}

export async function complete(system: string, user: string): Promise<string> {
  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return r.choices[0].message.content ?? "";
}
```

`backend/src/index.ts`
```ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import { pool } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

// health check also proves the DB connection works
app.get("/health", async (_req, res) => {
  const { rows } = await pool.query("select 1 as ok");
  res.json({ ok: rows[0].ok === 1 });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
```

> Note: with `"type": "module"`, import local files with a `.js` extension (e.g. `./db.js`) even though the file is `db.ts` — that's how Node ESM resolves TS via tsx.

**Run it:**
```bash
npm run dev
```
**Verify:** open `http://localhost:4000/health` → you should see `{"ok":true}`. That confirms Express + the database are both wired up.

---

## Step 3 — Run the schema migration

Put your schema in `backend/migrations/001_init.sql` (copy the full schema from the design doc §6, including the `related_products` table). Then load it into the running container:

```bash
# from the project root
docker compose exec -T db psql -U postgres -d discovery < backend/migrations/001_init.sql
```

**Verify:**
```bash
docker compose exec db psql -U postgres -d discovery -c "\dt"
```
You should see your tables (`products`, `variants`, `reviews`, `embeddings`, `related_products`, …).

---

## Step 4 — Frontend (React + TS + Tailwind v4)

```bash
cd ..                                   # back to project root
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install

# Tailwind v4 (uses the official Vite plugin — no init, no postcss config)
npm install tailwindcss @tailwindcss/vite
# icons used by the prototype
npm install lucide-react
```

Edit `frontend/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // optional: proxy API calls so you don't fight CORS in dev
  server: { proxy: { "/api": "http://localhost:4000" } },
});
```

Replace the contents of `frontend/src/index.css` with a single line:

```css
@import "tailwindcss";
```

(Make sure `src/main.tsx` imports it — the Vite template already has `import "./index.css";`.)

Drop the prototype component into `src/App.tsx` (use the light-theme `DiscoveryEngine_Light.jsx` you already have — rename to `.tsx`).

**Run it:**
```bash
npm run dev
```
**Verify:** open `http://localhost:5173` → the discovery engine UI renders and Tailwind styles apply.

---

## Step 5 — You now have three things running

| Terminal | Command (cwd) | URL | Proves |
|---|---|---|---|
| 1 | `docker compose up -d` (root) | — | Postgres + pgvector |
| 2 | `npm run dev` (backend) | http://localhost:4000/health | Express + DB |
| 3 | `npm run dev` (frontend) | http://localhost:5173 | UI + Tailwind |

That's the skeleton wired end-to-end. The next coding step is filling in `crawler.ts → ingest.ts → retrieve.ts → rag.ts → routes.ts`, then swapping the prototype's mock timers for real calls to `/ingest` and `/chat`.

---

## Open-source variant (no OpenAI key)

Keep everything above; only `ai.ts` changes.

```bash
# install Ollama (ollama.com), then pull models:
ollama pull qwen2.5:7b        # or llama3.1:8b  — the LLM
ollama pull bge-m3            # the embedding model
```

Rewrite `ai.ts` to call Ollama's local API (`http://localhost:11434`) instead of OpenAI. **Important:** bge-m3 outputs 1024-dim vectors, not 1536 — set your `embeddings.embedding` column to `vector(1024)` in the migration. Pick one embedding model before you embed anything; you can't mix dimensions in one index.

---

## Quick troubleshooting

- **Tailwind classes don't apply** → confirm `tailwindcss()` is in `vite.config.ts` plugins and `index.css` has `@import "tailwindcss";`, then restart the dev server. Don't follow v3 tutorials (no `init -p`, no `tailwind.config.js` needed).
- **`/health` fails / DB error** → is the Docker container up? Does `DATABASE_URL` in `.env` match the compose credentials?
- **Playwright launch error** → run `npx playwright install chromium` again; on Linux you may also need `npx playwright install-deps`.
- **ESM import errors in backend** → with `"type": "module"`, local imports need the `.js` suffix (`./db.js`).
