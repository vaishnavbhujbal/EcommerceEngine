-- 003_aeo_geo_advancements.sql — schema for three AEO/GEO advancements.
--
--  #4 JSON-LD export: store the schema.org structured data we generate per product
--     (Product + FAQPage), so it's a real, exportable answer-engine asset.
--  #6 direct-answer short-circuit: link each embedded `faq` chunk back to the
--     aeo_answers row it came from, so a strong query→FAQ vector match can return
--     the precomputed answer directly instead of re-generating it.
--
-- (#1 review-grounded AEO needs no schema change — the `reviews` table from 001 is
--  reused.) Safe to re-run: every change uses IF NOT EXISTS.

-- #4 — generated schema.org JSON-LD lives alongside the product.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS jsonld JSONB;

-- #6 — an embedded faq chunk points at its source Q&A. Nullable: only faq chunks set
-- it (description/spec/geo_content chunks leave it null). ON DELETE CASCADE keeps the
-- link clean when AEO is regenerated on re-ingest.
ALTER TABLE embeddings
  ADD COLUMN IF NOT EXISTS aeo_answer_id BIGINT REFERENCES aeo_answers(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS embeddings_aeo_answer_id_idx ON embeddings(aeo_answer_id);
