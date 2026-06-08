// retrieve.ts — hybrid retrieval: semantic vector search + live SQL fields.
//
// Pipeline (design doc §12):
//   1. Embed the shopper's query (via ai.ts).
//   2. Vector ANN over `embeddings` (cosine distance, HNSW index).
//   3. Apply structured SQL filters (in_stock, price range).
//   4. Join LIVE price/stock from `products` at query time (rule #2).
//   5. Return distinct products + their matched chunk + PDP citation.
//
// rag.ts consumes these candidates to ground the GPT-4o answer.

import { embed } from "./ai.js";
import { pool } from "./db.js";

// A product as returned to the RAG layer. price/stock are the LIVE SQL values.
export interface RetrievedProduct {
  id: number;
  source_url: string; // citation to the PDP
  title: string;
  brand: string | null;
  description: string | null;
  price_cents: number | null;
  currency: string | null;
  in_stock: boolean | null;
  rating_avg: number | null;
  rating_count: number | null;
  use_cases: string[] | null;
  specs: Array<{ name: string; value: string }>;
  matched_chunk: string | null; // which facet matched (description|geo_content|spec|faq)
  matched_content: string | null; // the text that matched (helps grounding)
  distance: number | null; // cosine distance (lower = closer)
}

export interface RetrieveOptions {
  limit?: number; // distinct products to return (default 5)
  inStockOnly?: boolean; // filter to in-stock products
  maxPriceCents?: number; // price ceiling (e.g. "under $200")
  maxDistance?: number; // relevance cap (cosine distance); see DEFAULT_MAX_DISTANCE
}

// Relevance gate (cosine distance: 0 = identical … 2 = opposite).
// Without this, retrieve() returns the top `limit` rows even when most are only
// distantly related — e.g. a "chair" query padding out with tables once the real
// chairs run out. Two complementary bounds keep results honest:
//   • DEFAULT_MAX_DISTANCE — an absolute cap; anything beyond is "not the same kind
//     of thing" and is dropped outright.
//   • RELEVANCE_WINDOW — a relative cap added to the closest match's distance, so a
//     vague query with a weak best-match can't drag in everything just under the cap.
// Both are tunable; if the catalog's real distances differ, adjust these two numbers.
const DEFAULT_MAX_DISTANCE = 0.6;
const RELEVANCE_WINDOW = 0.15;

/** Format an embedding vector as a pgvector literal: [0.1,0.2,...]. */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/** Pull the specs array out of the products.attributes JSONB safely. */
function specsFrom(attributes: any): Array<{ name: string; value: string }> {
  if (attributes && Array.isArray(attributes.specs)) return attributes.specs;
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Hybrid semantic retrieval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * retrieve — semantic search for products matching `query`, with live filters.
 *
 * We over-fetch chunk matches (limit × 4), then dedupe to distinct products in
 * JS, keeping each product's closest-matching chunk. This keeps the HNSW index
 * doing the heavy lifting while still returning whole products.
 */
export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedProduct[]> {
  const { limit = 5, inStockOnly = false, maxPriceCents, maxDistance = DEFAULT_MAX_DISTANCE } = opts;

  // 1) Embed the query.
  const [queryVec] = await embed([query]);
  const literal = toVectorLiteral(queryVec);

  // 2) Build the filtered ANN query. $1 = query vector, then optional filters.
  const params: any[] = [literal];
  const where: string[] = [];
  if (inStockOnly) where.push("p.in_stock = true");
  if (typeof maxPriceCents === "number") {
    params.push(maxPriceCents);
    where.push(`p.price_cents <= $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Over-fetch chunk rows ordered by cosine distance (uses the HNSW index).
  params.push(limit * 4);
  const sql = `
    SELECT p.id, p.source_url, p.title, p.brand, p.description, p.price_cents,
           p.currency, p.in_stock, p.rating_avg, p.rating_count, p.use_cases,
           p.attributes,
           e.chunk_type AS matched_chunk, e.content AS matched_content,
           (e.embedding <=> $1::vector) AS distance
    FROM embeddings e
    JOIN products p ON p.id = e.product_id
    ${whereSql}
    ORDER BY e.embedding <=> $1::vector
    LIMIT $${params.length}`;

  const { rows } = await pool.query(sql, params);

  // 3) Dedupe to distinct products, keeping the first (closest) chunk per product,
  //    and drop anything past the relevance gate. Rows are sorted by ascending
  //    distance, so the first row is the best match and once a row exceeds the
  //    effective cap every later row does too — we can stop scanning.
  const bestDistance = rows.length && rows[0].distance != null ? Number(rows[0].distance) : 0;
  const effectiveCap = Math.min(maxDistance, bestDistance + RELEVANCE_WINDOW);

  const seen = new Set<number>();
  const out: RetrievedProduct[] = [];
  for (const r of rows) {
    // Relevance gate: stop as soon as matches get too far from the query/best hit.
    if (r.distance != null && Number(r.distance) > effectiveCap) break;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: Number(r.id),
      source_url: r.source_url,
      title: r.title,
      brand: r.brand,
      description: r.description,
      price_cents: r.price_cents,
      currency: r.currency,
      in_stock: r.in_stock,
      rating_avg: r.rating_avg != null ? Number(r.rating_avg) : null,
      rating_count: r.rating_count != null ? Number(r.rating_count) : null,
      use_cases: r.use_cases ?? null,
      specs: specsFrom(r.attributes),
      matched_chunk: r.matched_chunk,
      matched_content: r.matched_content,
      distance: r.distance != null ? Number(r.distance) : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anchor product (the URL the user supplied)
// ─────────────────────────────────────────────────────────────────────────────

export interface AnchorProduct extends RetrievedProduct {
  aeo: Array<{ question: string; answer: string; answer_type: string }>;
}

/**
 * getProductByUrl — fetch the product for a specific PDP URL, with its AEO answers.
 * Returns null if that URL hasn't been ingested yet (caller can then ingest it).
 */
export async function getProductByUrl(url: string): Promise<AnchorProduct | null> {
  const { rows } = await pool.query(
    `SELECT id, source_url, title, brand, description, price_cents, currency,
            in_stock, rating_avg, rating_count, use_cases, attributes
     FROM products WHERE source_url = $1`,
    [url]
  );
  if (rows.length === 0) return null;
  const r = rows[0];

  const aeo = await pool.query(
    `SELECT question, answer, answer_type FROM aeo_answers WHERE product_id = $1`,
    [r.id]
  );

  return {
    id: Number(r.id),
    source_url: r.source_url,
    title: r.title,
    brand: r.brand,
    description: r.description,
    price_cents: r.price_cents,
    currency: r.currency,
    in_stock: r.in_stock,
    rating_avg: r.rating_avg != null ? Number(r.rating_avg) : null,
    rating_count: r.rating_count != null ? Number(r.rating_count) : null,
    use_cases: r.use_cases ?? null,
    specs: specsFrom(r.attributes),
    matched_chunk: null,
    matched_content: null,
    distance: null,
    aeo: aeo.rows,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Merchandising: Most Popular rail (by review count)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * mostPopular — products ranked by rating_count (honest popularity proxy).
 * Optionally restricted to in-stock items.
 */
export async function mostPopular(limit = 5, inStockOnly = false): Promise<RetrievedProduct[]> {
  const where = inStockOnly ? "WHERE rating_count IS NOT NULL AND in_stock = true" : "WHERE rating_count IS NOT NULL";
  const { rows } = await pool.query(
    `SELECT id, source_url, title, brand, description, price_cents, currency,
            in_stock, rating_avg, rating_count, use_cases, attributes
     FROM products
     ${where}
     ORDER BY rating_count DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    source_url: r.source_url,
    title: r.title,
    brand: r.brand,
    description: r.description,
    price_cents: r.price_cents,
    currency: r.currency,
    in_stock: r.in_stock,
    rating_avg: r.rating_avg != null ? Number(r.rating_avg) : null,
    rating_count: r.rating_count != null ? Number(r.rating_count) : null,
    use_cases: r.use_cases ?? null,
    specs: specsFrom(r.attributes),
    matched_chunk: null,
    matched_content: null,
    distance: null,
  }));
}
