# AI-Powered Ecommerce Discovery Engine — POC Technical Design

**Audience:** Enterprise architects, Director of Technology, stakeholder + committee review
**Goal:** Prove an ecommerce-specific AEO/GEO discovery engine produces more accurate, conversion-oriented answers for a *specific catalog* than generic assistants (ChatGPT, Perplexity).
**Build window:** 3–5 day POC.

---

## 0. The One-Sentence Pitch

> Generic AI assistants answer questions about the *world*. This engine answers questions about *your catalog* — with live price, live stock, real promos, margin-aware recommendations, and a one-click path to purchase — none of which ChatGPT or Perplexity can do reliably for your SKUs.

---

## 1. Business Problem (answers Q1–Q2)

| Problem | Cost to the business |
|---|---|
| Shoppers increasingly start product research in ChatGPT/Perplexity, not Google. | Your catalog becomes invisible in the new discovery layer ("AI-search dark"). |
| Generic AI hallucinates SKUs, quotes stale/wrong prices, recommends competitors. | Lost trust, lost sales, brand risk. |
| On-site search is keyword-based; it fails on natural-language intent ("gift for a dad who hikes, under $100"). | High search abandonment, low discovery. |
| No system connects intent → product → upsell → cart in one conversational flow. | Low AOV, weak cross-sell, friction to purchase. |

**Why invest:** the discovery layer is shifting from search engines to answer engines. Whoever owns an accurate, conversion-optimized answer surface for their own catalog captures the demand that generic assistants can't serve.

---

## 2. AEO vs GEO — definitions used here

- **AEO (Answer Engine Optimization):** structuring catalog data so an answer engine can return a *direct, correct, citable answer* to a specific question ("Is the X in stock in size M and what's today's price?"). It's about machine-answerable truth: schema, structured facts, Q&A pairs, citations.
- **GEO (Generative Engine Optimization):** shaping catalog *content representations* so generative engines (ChatGPT, Perplexity, Gemini, and your own RAG) are more likely to surface and recommend your products — entity-rich descriptions, comparison framing, use-case language, FAQ coverage, and authority signals.

AEO = "answer correctly." GEO = "get chosen and cited."

---

## 3. Architecture (Deliverable 1)

```
                          ┌─────────────────────────────────────────────┐
                          │                 FRONTEND (React + TS)         │
                          │  Split-screen demo:                           │
                          │  ┌───────────────┐   ┌──────────────────────┐ │
                          │  │ Generic AI     │   │ Ecommerce Engine     │ │
                          │  │ (GPT-4o, no    │   │ (RAG + live catalog) │ │
                          │  │  catalog)      │   │ + Add-to-cart + upsell│ │
                          │  └───────────────┘   └──────────────────────┘ │
                          └───────────────────────┬─────────────────────┘
                                                  │ REST/SSE
                          ┌───────────────────────▼─────────────────────┐
                          │              BACKEND (Node.js + Express)      │
                          │                                               │
                          │  /chat        → RAG orchestrator              │
                          │  /search      → hybrid retrieval              │
                          │  /recommend   → conversion engine             │
                          │  /ingest      → crawl + extract trigger       │
                          │  /metrics     → eval harness                  │
                          └───┬───────────┬──────────────┬───────────────┘
                              │           │              │
              ┌───────────────▼──┐  ┌─────▼───────┐  ┌───▼──────────────┐
              │ Crawler (Playwright)│ │ LLM (GPT-4o)│  │ Embeddings        │
              │ render JS, extract  │ │ answer+rank │  │ (text-embedding-3)│
              │ JSON-LD + DOM       │ └─────────────┘  └───┬──────────────┘
              └─────────┬──────────┘                       │
                        │ structured product records       │ vectors
                        ▼                                   ▼
              ┌──────────────────────────────────────────────────────────┐
              │          PostgreSQL + pgvector                            │
              │  products | variants | reviews | faqs | specs |           │
              │  promotions | embeddings | query_logs                     │
              │  ── live fields (price, stock) queried at answer-time ──  │
              └──────────────────────────────────────────────────────────┘
```

**Critical design rule:** price, stock, and promo are **NOT** baked into embeddings. Embeddings encode *semantics* (what the product is/does/for whom). Volatile facts live in SQL columns and are joined in at answer-time. This is the single most important correctness decision in the system — it's also the thing generic assistants structurally cannot do.

---

## 4. Backend Folder Structure (Deliverable 2)

```
backend/
├── src/
│   ├── server.ts                 # Express bootstrap
│   ├── config/
│   │   ├── env.ts                # env validation (OpenAI key, PG url)
│   │   └── db.ts                 # pg pool + pgvector init
│   ├── routes/
│   │   ├── chat.routes.ts        # POST /chat (SSE stream)
│   │   ├── search.routes.ts      # POST /search
│   │   ├── recommend.routes.ts   # POST /recommend
│   │   ├── ingest.routes.ts      # POST /ingest
│   │   └── metrics.routes.ts     # POST /metrics/eval
│   ├── crawler/
│   │   ├── browser.ts            # Playwright launch + context pool
│   │   ├── crawl.ts             # sitemap/category walker
│   │   ├── extractors/
│   │   │   ├── jsonld.ts        # schema.org Product/Offer/Review
│   │   │   ├── dom.ts           # fallback DOM selectors
│   │   │   ├── reviews.ts
│   │   │   ├── faq.ts
│   │   │   └── specs.ts
│   │   └── normalize.ts         # → canonical Product record
│   ├── aeo/
│   │   ├── schema.builder.ts    # build AEO knowledge objects + Q&A pairs
│   │   └── answerability.ts     # score "can this be answered directly?"
│   ├── geo/
│   │   ├── content.builder.ts   # GEO content representations per product
│   │   └── comparison.ts        # entity/comparison framing
│   ├── embeddings/
│   │   ├── embed.ts             # OpenAI embeddings client + batching
│   │   └── chunk.ts            # semantic chunking strategy
│   ├── retrieval/
│   │   ├── vector.ts           # pgvector ANN search
│   │   ├── hybrid.ts           # vector + keyword + filters
│   │   └── rerank.ts           # (optional) LLM/cross-encoder rerank
│   ├── rag/
│   │   ├── orchestrator.ts     # plan → retrieve → ground → answer
│   │   ├── prompts.ts          # system prompts + guardrails
│   │   └── grounding.ts        # citation + "only-our-catalog" enforcement
│   ├── recommend/
│   │   ├── engine.ts           # cross-sell / upsell / bundle logic
│   │   └── rules.ts            # margin / inventory / AOV rules
│   ├── eval/
│   │   ├── prompts.json        # 10 eval prompts
│   │   └── scorer.ts           # accuracy/grounding/actionability scoring
│   └── lib/
│       ├── openai.ts
│       └── logger.ts
├── prisma/ or migrations/
│   └── 001_init.sql
├── package.json
└── tsconfig.json
```

---

## 5. Frontend Folder Structure (Deliverable 3)

```
frontend/
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── SplitCompare.tsx       # the money shot: side-by-side
│   │   ├── GenericPanel.tsx       # GPT-4o w/o catalog (or Perplexity embed)
│   │   ├── EnginePanel.tsx        # our RAG answer
│   │   ├── ProductCard.tsx        # price/stock/promo + Add to cart
│   │   ├── UpsellRail.tsx         # "complete the look" / bundle
│   │   ├── CitationBadge.tsx      # AEO citations to PDPs
│   │   ├── MetricsBar.tsx         # accuracy / latency / actionability
│   │   └── ChatInput.tsx
│   ├── hooks/
│   │   ├── useChatStream.ts       # SSE consumer
│   │   └── useMetrics.ts
│   ├── lib/
│   │   └── api.ts
│   ├── pages/
│   │   ├── Demo.tsx               # the live demo screen
│   │   └── Scorecard.tsx          # eval results dashboard
│   └── styles/  (Tailwind)
├── index.html
├── tailwind.config.js
├── tsconfig.json
└── package.json
```

---

## 6. Database Schema (Deliverable 4)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE products (
  id            BIGSERIAL PRIMARY KEY,
  source_url    TEXT UNIQUE NOT NULL,
  sku           TEXT,
  title         TEXT NOT NULL,
  brand         TEXT,
  category      TEXT,
  description   TEXT,
  use_cases     TEXT[],            -- GEO: "gift", "hiking", "office"
  attributes    JSONB,             -- color, size, material, etc.
  -- LIVE FIELDS (queried at answer-time, NOT embedded):
  price_cents   INTEGER,
  currency      TEXT DEFAULT 'USD',
  in_stock      BOOLEAN,
  stock_qty     INTEGER,
  margin_pct    NUMERIC,           -- powers margin-aware ranking
  rating_avg    NUMERIC,
  rating_count  INTEGER,
  crawled_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE variants (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  variant_sku TEXT,
  options     JSONB,               -- {"size":"M","color":"navy"}
  price_cents INTEGER,
  in_stock    BOOLEAN
);

CREATE TABLE reviews (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  rating      INTEGER,
  title       TEXT,
  body        TEXT,
  sentiment   NUMERIC,             -- precomputed
  helpful     INTEGER
);

CREATE TABLE faqs (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  question    TEXT,
  answer      TEXT
);

CREATE TABLE specs (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  name        TEXT,
  value       TEXT
);

CREATE TABLE promotions (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  label       TEXT,                -- "20% off", "BOGO"
  discount_pct NUMERIC,
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ
);

-- AEO knowledge: machine-answerable Q&A pairs
CREATE TABLE aeo_answers (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  question    TEXT,
  answer      TEXT,
  answer_type TEXT                 -- price | availability | spec | comparison | usecase
);

-- One embeddings table; embed semantic content only
CREATE TABLE embeddings (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  chunk_type  TEXT,                -- description | review_summary | faq | spec | geo_content
  content     TEXT,
  embedding   vector(1536)         -- text-embedding-3-small
);
CREATE INDEX ON embeddings USING hnsw (embedding vector_cosine_ops);

-- Analytics loop (turns every query into merchandising/SEO insight)
CREATE TABLE query_logs (
  id            BIGSERIAL PRIMARY KEY,
  query         TEXT,
  matched_ids   BIGINT[],
  answered      BOOLEAN,
  had_in_stock  BOOLEAN,
  clicked_id    BIGINT,
  added_to_cart BOOLEAN,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

---

## 7. Product Extraction Pipeline (Deliverable 5)

1. **Discover URLs** — read `sitemap.xml` or walk category pages with Playwright.
2. **Render** — load each PDP with Playwright (handles JS-rendered SPAs that `fetch` would miss).
3. **Extract (priority order):**
   - **JSON-LD `schema.org/Product`** first (most reliable: name, price, availability, aggregateRating, offers).
   - **DOM fallback** with site-specific selectors when JSON-LD is absent.
   - Reviews, FAQ accordion, spec tables, promo badges.
4. **Normalize** → canonical `Product` record (currency, units, booleans).
5. **Enrich** → sentiment on reviews, dedupe variants, classify use-cases.
6. **Persist** → SQL tables; mark `crawled_at`.
7. **Build AEO + GEO artifacts** (sections 9–10).
8. **Embed + index** (section 11).

> **Fallback for the demo:** if a target site blocks crawling, ingest its **product feed / CSV / sitemap** instead. The architecture is source-agnostic; do not let crawl fragility break the demo.

---

## 8. Headless Browser — Playwright (Deliverable 8)

```ts
// crawler/browser.ts
import { chromium, Browser } from 'playwright';
let browser: Browser;
export async function getBrowser() {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

// crawler/extractors/jsonld.ts
export async function extractProduct(page) {
  // 1) Prefer structured data
  const jsonld = await page.$$eval(
    'script[type="application/ld+json"]',
    nodes => nodes.map(n => n.textContent)
  );
  const product = parseSchemaOrgProduct(jsonld); // name, offers.price, availability, rating
  if (product) return product;

  // 2) DOM fallback
  return {
    title: await page.locator('h1').first().innerText(),
    price: await page.locator('[data-price], .price').first().innerText().catch(()=>null),
    inStock: await page.locator('text=/in stock/i').count() > 0,
    description: await page.locator('[itemprop=description], .product-description').innerText().catch(()=>''),
    reviews: await page.$$eval('.review', els => els.map(e => e.innerText)),
  };
}
```

Politeness/robustness: respect `robots.txt`, throttle concurrency, set a real user-agent, retry with backoff, cache rendered HTML.

---

## 9. AEO Implementation Strategy (Deliverable 6)

**Goal:** make every product *directly answerable*.

- Generate **Q&A pairs per product** across answer types: price, availability, sizing/fit, spec lookups, "is X compatible with Y," use-case suitability, return policy.
- Store as `aeo_answers`; embed them so retrieval can surface a ready answer.
- Emit **schema.org JSON-LD** (Product, Offer, FAQPage, AggregateRating) for the brand's *own* site so external answer engines can parse it (this is the externally-facing AEO win).
- **Answerability score:** for any incoming question, can we return a grounded direct answer with a citation? Track % answerable as a KPI.
- **Citations:** every answer links to the PDP it came from — trust + click-through.

## 10. GEO Implementation Strategy (Deliverable 7)

**Goal:** make products more likely to be surfaced/recommended by generative engines.

- **Entity-rich rewrites:** convert thin marketing copy into descriptions dense with attributes, materials, use-cases, and audience ("for beginner hikers," "machine-washable," "gift under $100").
- **Comparison framing:** generate "X vs Y," "best X for Z" content so the catalog matches how people ask generative engines.
- **FAQ coverage:** fill gaps so common questions have on-catalog answers.
- **Use-case clustering:** tag products to intents (gifting, travel, budget, premium) to power intent-based discovery.
- **Authority signals:** aggregate review themes into trustworthy summaries.
- **External GEO:** publish the structured/FAQ content on the brand site so ChatGPT/Perplexity cite *your* pages instead of competitors.

---

## 11. Embedding Pipeline (Deliverable 9)

1. Build per-product **semantic documents** (description + GEO rewrite + review summary + FAQ + specs) — **excluding** price/stock.
2. **Chunk** by `chunk_type` so retrieval can target the right facet.
3. Call OpenAI `text-embedding-3-small` (1536-d) in **batches**; store in `embeddings`.
4. Index with **HNSW** (`vector_cosine_ops`).
5. **Re-embed only on semantic change** (description edits) — *not* on price/stock changes, which are SQL-only. This keeps embedding cost low and answers always price-accurate.

## 12. Retrieval Pipeline (Deliverable 10)

**Hybrid retrieval:**
1. Embed the user query.
2. **Vector ANN** over `embeddings` (top-k semantic matches).
3. **Structured filters** in SQL: `in_stock = true`, price range, category, attributes parsed from the query.
4. **(Optional) rerank** top candidates with GPT-4o or a cross-encoder.
5. **Join live fields** (price/stock/promo) at this step — answers are always current.
6. Return candidates + their PDP citations to the RAG layer.

## 13. RAG Architecture (Deliverable 11)

```
User query
   │
   ▼
[Plan] classify intent (lookup | discovery | comparison | gift | troubleshoot)
   │
   ▼
[Retrieve] hybrid retrieval (vector + filters) → top candidates w/ live price/stock
   │
   ▼
[Ground] inject ONLY retrieved catalog facts into context; attach citations
   │
   ▼
[Answer] GPT-4o with strict system prompt:
   - answer ONLY from provided catalog context
   - never invent SKUs/prices; if unknown, say so
   - always include price, stock, and 1 upsell + 1 cross-sell when relevant
   - return structured product cards + a conversational answer
   │
   ▼
[Recommend] conversion engine adds bundle/upsell (section 14)
   │
   ▼
[Log] query_logs for the analytics loop
```

Guardrails: out-of-catalog questions return "not in our catalog" instead of hallucinating; refusal to quote a price not present in context.

---

## 14. Conversion-Focused Recommendation Engine (Deliverable 14)

Layered ranking (answers Q3, Q4, Q6):

1. **Relevance** (vector similarity) — get the right products.
2. **Availability** — never recommend out-of-stock (kills generic-AI failure mode).
3. **Cross-sell** — "frequently bought together" / complementary categories (raises UPT).
4. **Upsell** — next tier up when it fits the stated need (raises AOV).
5. **Bundle** — propose a kit at a small discount (raises AOV + UPT).
6. **Business rules** — tie-break toward higher `margin_pct` or overstock when relevance is equal (protects margin; generic AI has no concept of *your* economics).

Every answer ends with a concrete next action: **Add to cart / View bundle**.

---

## 15. 10 Ecommerce Evaluation Prompts (Deliverable 12)

These are designed to expose where generic AI fails on a specific catalog:

1. "I need a gift for my dad who loves hiking, under $100. What do you recommend?"
2. "Is the [Product X] in stock in size M right now, and what's the price today?"
3. "What's the difference between [Product A] and [Product B], and which is better for a beginner?"
4. "I'm buying [Product X] — what else do I need to go with it?"
5. "Show me your best-rated waterproof jackets under $150 that are in stock."
6. "Is there any promotion on [category] this week?"
7. "I have a $200 budget for a complete [use-case] setup. Build me a bundle."
8. "Which of your products is best for [specific use-case], and why?"
9. "Do you have anything like [competitor/generic product] but in your store?"
10. "What do reviewers say are the downsides of [Product X]?"

For each: capture **generic AI answer** vs **engine answer**, then score.

## 16. Metrics vs ChatGPT / Perplexity (Deliverable 13)

| Metric | What it measures | Why generic AI loses |
|---|---|---|
| **Catalog accuracy** | % of price/stock facts correct | Generic AI has no live catalog access |
| **Grounding/citation rate** | % answers linked to a real PDP | Generic AI often can't cite your SKUs |
| **Hallucination rate** | % answers inventing SKUs/prices | Structurally high for generic AI on private catalogs |
| **In-stock recommendation rate** | % recs that are actually buyable | Generic AI recommends unavailable/competitor items |
| **Actionability** | % answers with add-to-cart/bundle | Generic AI cannot transact |
| **Recommendation relevance (P@k)** | human-rated relevance | Comparable, but ours is catalog-tuned |
| **Latency / cost per query** | ops viability | Controlled in-house |

**Business KPIs expected to improve (answers Q9):** conversion rate (CVR), average order value (AOV), units per transaction (UPT, cross-sell), add-to-cart rate, revenue per visitor (RPV), search abandonment ↓, AI-search citation share ↑, assisted revenue ↑.

---

## 17. Team Benefits

**Sales (Deliverable 15 / Q8):**
- Higher CVR from accurate, in-stock, action-ready answers.
- Higher AOV/UPT via automated upsell + bundles on every interaction.
- 24/7 "best sales rep" that never quotes a wrong price or pushes out-of-stock.
- Query logs reveal demand signals and objection patterns to act on.

**Marketing (Deliverable 16 / Q7):**
- GEO: structured, FAQ-rich content makes the brand citable in ChatGPT/Perplexity → **AI-search visibility**.
- AEO: schema/Q&A coverage wins direct answers → traffic and trust.
- Query logs = a live voice-of-customer + content-gap engine (what people ask that the catalog doesn't answer).
- Measurable share-of-answer vs competitors in generative engines.

---

## 18. Unique Capabilities ChatGPT/Perplexity Can't Match (Q10)

1. **Live, correct** price/stock/promo for *your* SKUs.
2. **Guaranteed grounding** — only your products, no competitor leakage, no invented SKUs.
3. **Transactional** — add-to-cart, bundles, checkout path inside the answer.
4. **Margin/inventory-aware** ranking tuned to *your* economics.
5. **Personalization** to cart/session/history.
6. **Analytics loop** — every query becomes merchandising + SEO/GEO intelligence you own.
7. **Data ownership & control** — no consumer-chat vendor lock, controllable cost/latency/compliance.

---

## 19. Implementation Roadmap — 3–5 Day POC (Deliverable 17)

| Day | Deliverable |
|---|---|
| **Day 1** | Repo + Postgres/pgvector up. Playwright crawler on ONE category (~200–500 SKUs) **or** CSV/feed fallback. Normalize → SQL. |
| **Day 2** | AEO Q&A generation + GEO rewrites. Embedding pipeline → pgvector + HNSW. Hybrid retrieval working. |
| **Day 3** | RAG orchestrator + grounding + conversion engine. `/chat` SSE endpoint. Minimal React split-screen UI with product cards + add-to-cart. **End of Day 3 = demoable MVP.** |
| **Day 4** | Eval harness: run 10 prompts through engine vs generic GPT-4o (and capture live Perplexity/ChatGPT outputs). Scorecard dashboard. Polish demo flow + 3 rock-solid scripted queries. |
| **Day 5** | Buffer + dry run. Record a backup video. Finalize pitch deck. |

---

## 20. Smallest 3-Day MVP (the cut line)

**Keep:** one category ingest (or CSV), embeddings + pgvector, hybrid retrieval, RAG `/chat`, grounding guardrail, conversion engine (1 upsell + 1 cross-sell), split-screen UI with add-to-cart, 3 scripted demo queries.

**Cut for v1:** multi-site crawl, login/personalization (use session), real checkout (mock cart), reranker, full review NLP, admin dashboards, automated Perplexity API integration (capture its output live in the browser instead).

---

## 21. Biggest Risks + Mitigations

| Risk | Mitigation |
|---|---|
| Crawl blocked / brittle (anti-bot, JS, ToS) | Use the brand's **own** catalog via feed/sitemap/CSV; pick crawl-friendly target. |
| "You handicapped ChatGPT" objection | Be honest: generic AI *genuinely* can't access a private live catalog — that's the thesis, not a trick. Show its real output. |
| Your own RAG hallucinates | Strict grounding prompt + "answer only from context" + citation enforcement. |
| Stale price/stock | Keep volatile fields in SQL, joined at answer-time; never embed them. |
| Scope creep (17 deliverables in 5 days) | Build the demo-critical path; everything else is design-on-paper for the deck. |
| Live demo fails on stage | Pre-warm cache, scripted queries, recorded backup video. |
| "Vendors already do this" (Algolia/Klevu/Bloomreach) | Position as control + ownership + AEO/GEO + analytics loop; this is a buy-vs-build framing, not a claim of novelty. |

---

## 22. How a Director of Technology Will Challenge This (prep your answers)

1. **"Why not just connect our product feed to a custom GPT / function-calling and skip all this?"**
   → You can prototype that, but you lose grounding guarantees, margin-aware ranking, data ownership, analytics, latency/cost control, and you tie your conversion surface to a consumer-chat vendor's roadmap and pricing.
2. **"How do you keep price and inventory accurate?"**
   → Volatile fields are SQL-only, joined at answer-time; embeddings are semantic and re-built only on content change.
3. **"What's cost per query at scale?"**
   → Embeddings cached/reused; retrieval is cheap; one GPT-4o call per answer; show token math + caching strategy.
4. **"How is this different from Algolia/Klevu/Bloomreach AI search?"**
   → Acknowledge them. Position POC as proving the AEO/GEO + ownership value; buy-vs-build is a later decision.
5. **"How do you *prove* conversion lift, not just nicer answers?"**
   → A/B test with holdout post-POC; POC proves answer accuracy + actionability as leading indicators.
6. **"Hallucination liability — what if it promises a wrong price?"**
   → Grounding guardrails + "only from catalog" + the price shown is the live SQL value, not generated text.
7. **"Maintenance as the catalog changes daily?"**
   → Incremental feed/crawl sync; SQL updates are cheap; re-embed only changed content.

---

## 23. The 5-Minute Demo Script (biggest wow factor)

1. **(30s)** Frame: "Shoppers now ask AI, not Google. Watch what happens when they ask about *your* catalog."
2. **(90s)** Type into **ChatGPT/Perplexity** live: *"Gift for a dad who hikes, under $100, in stock."* → it gives generic advice / hallucinated or competitor products / no live price / no buy button.
3. **(120s)** Type the **same query** into the engine → returns 3 **in-stock** SKUs from the real catalog with **today's price**, **active promo**, a **citation to the PDP**, a **cross-sell** ("add these trekking socks") and an **upsell bundle** — with **Add to cart**.
4. **(60s)** Flip to the **scorecard**: catalog accuracy, hallucination rate, in-stock rate, actionability — engine vs generic, on the 10 prompts.
5. **Close:** "Generic AI answers about the world. This answers about *your* store — accurately, and with a path to purchase. That gap is conversions you're currently losing to the AI discovery layer."
