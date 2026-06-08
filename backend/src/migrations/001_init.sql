-- 001_init.sql — initial schema for the Discovery Engine (design doc §6).
--
-- Core correctness rule baked into this schema (golden rule #2):
--   * SEMANTIC data (descriptions, reviews, FAQs, specs, GEO content) is embedded
--     and lives in `embeddings` as vectors.
--   * VOLATILE data (price, stock, promo) lives as plain SQL columns and is joined
--     in at answer-time — NEVER embedded — so answers are always current.
--
-- This migration is written to be safely re-runnable: every CREATE uses
-- IF NOT EXISTS, so re-applying it during POC iteration won't error.

-- pgvector: required for the vector(1536) column and the HNSW index below.
-- On Supabase this normally succeeds; if it errors on permissions, enable the
-- `vector` extension once via Database → Extensions in the dashboard.
CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────────────────────────────────────────────────────
-- Catalog core
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS products (
  id            BIGSERIAL PRIMARY KEY,
  source_url    TEXT UNIQUE NOT NULL,   -- crawler's natural key (used for upserts)
  sku           TEXT,
  title         TEXT NOT NULL,
  brand         TEXT,
  category      TEXT,
  description   TEXT,
  use_cases     TEXT[],                 -- GEO: "gift", "hiking", "office"
  attributes    JSONB,                  -- color, size, material, etc.
  -- LIVE FIELDS (queried at answer-time, NOT embedded):
  price_cents   INTEGER,
  currency      TEXT DEFAULT 'USD',
  in_stock      BOOLEAN,
  stock_qty     INTEGER,
  margin_pct    NUMERIC,                -- powers margin-aware ranking
  rating_avg    NUMERIC,
  rating_count  INTEGER,
  crawled_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS variants (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  variant_sku TEXT,
  options     JSONB,                    -- {"size":"M","color":"navy"}
  price_cents INTEGER,
  in_stock    BOOLEAN
);

CREATE TABLE IF NOT EXISTS reviews (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  rating      INTEGER,
  title       TEXT,
  body        TEXT,
  sentiment   NUMERIC,                  -- precomputed
  helpful     INTEGER
);

CREATE TABLE IF NOT EXISTS faqs (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  question    TEXT,
  answer      TEXT
);

CREATE TABLE IF NOT EXISTS specs (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  name        TEXT,
  value       TEXT
);

CREATE TABLE IF NOT EXISTS promotions (
  id           BIGSERIAL PRIMARY KEY,
  product_id   BIGINT REFERENCES products(id) ON DELETE CASCADE,
  label        TEXT,                    -- "20% off", "BOGO"
  discount_pct NUMERIC,
  starts_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ
);

-- AEO knowledge: machine-answerable Q&A pairs (embedded so retrieval can surface
-- a ready answer; see embeddings.chunk_type below).
CREATE TABLE IF NOT EXISTS aeo_answers (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  question    TEXT,
  answer      TEXT,
  answer_type TEXT                      -- price | availability | spec | comparison | usecase
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Conversion engine: product→product relationships (cross-sell / upsell / bundle).
-- Not in design doc §6, but required by CLAUDE.md build order. rag.ts's
-- recommendation engine self-joins products through this to attach "1 upsell +
-- 1 cross-sell" to an answer (§14).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS related_products (
  id            BIGSERIAL PRIMARY KEY,
  product_id    BIGINT REFERENCES products(id) ON DELETE CASCADE,
  related_id    BIGINT REFERENCES products(id) ON DELETE CASCADE,
  relation_type TEXT,                   -- cross_sell | upsell | bundle
  rank          INTEGER                 -- ordering / strength of the relationship
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Embeddings: ONE table, semantic content only. Volatile fields never land here.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS embeddings (
  id          BIGSERIAL PRIMARY KEY,
  product_id  BIGINT REFERENCES products(id) ON DELETE CASCADE,
  chunk_type  TEXT,                     -- description | review_summary | faq | spec | geo_content
  content     TEXT,
  embedding   vector(1536)              -- text-embedding-3-small (matches EMBEDDING_DIM in ai.ts)
);

-- Approximate nearest-neighbour index for fast cosine similarity search.
CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw
  ON embeddings USING hnsw (embedding vector_cosine_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- Analytics loop: turns every query into merchandising/SEO insight.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS query_logs (
  id            BIGSERIAL PRIMARY KEY,
  query         TEXT,
  matched_ids   BIGINT[],
  answered      BOOLEAN,
  had_in_stock  BOOLEAN,
  clicked_id    BIGINT,
  added_to_cart BOOLEAN,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Supporting indexes (additive to the spec's HNSW index).
-- Child tables are always queried by product_id at answer-time, and products are
-- filtered by category / stock — these keep those joins and filters fast.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS variants_product_id_idx          ON variants(product_id);
CREATE INDEX IF NOT EXISTS reviews_product_id_idx           ON reviews(product_id);
CREATE INDEX IF NOT EXISTS faqs_product_id_idx              ON faqs(product_id);
CREATE INDEX IF NOT EXISTS specs_product_id_idx             ON specs(product_id);
CREATE INDEX IF NOT EXISTS promotions_product_id_idx        ON promotions(product_id);
CREATE INDEX IF NOT EXISTS aeo_answers_product_id_idx       ON aeo_answers(product_id);
CREATE INDEX IF NOT EXISTS related_products_product_id_idx  ON related_products(product_id);
CREATE INDEX IF NOT EXISTS embeddings_product_id_idx        ON embeddings(product_id);
CREATE INDEX IF NOT EXISTS products_category_idx            ON products(category);
CREATE INDEX IF NOT EXISTS products_in_stock_idx            ON products(in_stock);
