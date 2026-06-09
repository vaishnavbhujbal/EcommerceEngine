-- 002_hybrid_search.sql — add full-text search to enable HYBRID retrieval.
--
-- 001 gave us semantic search (the HNSW vector index on `embeddings`). Pure vector
-- search is great for meaning but can rank exact tokens poorly — a brand, a model
-- number, a product line like "MALM", or a SKU. This migration adds a keyword
-- (lexical) signal so retrieve.ts can fuse the two (Reciprocal Rank Fusion).
--
-- Safe to re-run: ADD COLUMN / CREATE INDEX both use IF NOT EXISTS.

-- A generated tsvector over the product's text fields. Weighted so a title hit
-- outranks a description hit (A > B > C) when we ts_rank the matches.
--
-- Notes:
--  * We pass the config as 'english'::regconfig (an explicit cast). A GENERATED
--    column requires an IMMUTABLE expression; the bare to_tsvector('english', …)
--    form is treated as non-immutable and is rejected, while the ::regconfig cast
--    constant-folds the config and makes the whole expression immutable.
--  * We index title (A) / brand+category (B) / description (C). use_cases (TEXT[])
--    is intentionally omitted: flattening it needs array_to_string(), which is only
--    STABLE (not IMMUTABLE) and so is illegal in a generated column. That's fine —
--    use_cases is semantic content already covered by the vector arm; keyword search
--    is here for the exact tokens (title, brand, model) the vector arm underweights.
--  * STORED means Postgres computes the value now for every existing row too — no
--    separate backfill script is needed.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(brand, '') || ' ' || coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'C')
  ) STORED;

-- GIN index makes the `search_tsv @@ query` lookup fast.
CREATE INDEX IF NOT EXISTS products_search_tsv_gin
  ON products USING gin (search_tsv);
