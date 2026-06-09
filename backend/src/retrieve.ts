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

import { embed, rerank } from "./ai.js";
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
  crawled_at: string | null; // ISO timestamp of the last crawl — powers the "verified live" badge
}

export interface RetrieveOptions {
  limit?: number; // distinct products to return (default 5)
  inStockOnly?: boolean; // filter to in-stock products
  maxPriceCents?: number; // price ceiling (e.g. "under $200")
  maxDistance?: number; // relevance cap (cosine distance); see DEFAULT_MAX_DISTANCE
  rerankResults?: boolean; // run the LLM re-ranker over the fused shortlist
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

/** Normalize a pg timestamp (Date or string) to an ISO string, or null. */
function toIso(ts: any): string | null {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// The product columns both retrieval arms select. Kept in one place so the vector
// and keyword queries return identically-shaped rows that rowToProduct can map.
const PRODUCT_COLS = `p.id, p.source_url, p.title, p.brand, p.description, p.price_cents,
       p.currency, p.in_stock, p.rating_avg, p.rating_count, p.use_cases,
       p.attributes, p.crawled_at`;

/** Map a joined products row to a RetrievedProduct. The vector-only fields
 *  (matched_chunk/matched_content/distance) default to null for keyword rows. */
function rowToProduct(r: any): RetrievedProduct {
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
    matched_chunk: r.matched_chunk ?? null,
    matched_content: r.matched_content ?? null,
    distance: r.distance != null ? Number(r.distance) : null,
    crawled_at: toIso(r.crawled_at),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hybrid semantic retrieval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * retrieve — HYBRID search for products matching `query`, with live filters.
 *
 * Two retrieval arms run with the same product filters, then fuse:
 *   • VECTOR (semantic): top chunk matches over the HNSW index, deduped to the
 *     best chunk per product — catches meaning ("comfy seat for a small room").
 *   • KEYWORD (lexical): full-text search over products.search_tsv — catches exact
 *     tokens vector search underweights (brand, model #, a product line, a SKU).
 *
 * The two ranked lists are merged with Reciprocal Rank Fusion (RRF), gated for
 * relevance, and — when `rerankResults` is set — reordered by a small LLM that
 * actually reads query + candidates. rag.ts consumes the result to ground GPT-4o.
 */
export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedProduct[]> {
  const {
    limit = 5,
    inStockOnly = false,
    maxPriceCents,
    maxDistance = DEFAULT_MAX_DISTANCE,
    rerankResults = false,
  } = opts;

  // Over-fetch each arm so RRF has a healthy pool to fuse from.
  const POOL = Math.max(limit * 4, 20);

  // Product-level filters shared by both arms. `startIdx` is the next free $-index
  // (each arm already uses $1 for its own search input).
  function productFilters(startIdx: number): { clause: string; params: any[] } {
    const parts: string[] = [];
    const params: any[] = [];
    if (inStockOnly) parts.push("p.in_stock = true");
    if (typeof maxPriceCents === "number") {
      params.push(maxPriceCents);
      parts.push(`p.price_cents <= $${startIdx + params.length - 1}`);
    }
    return { clause: parts.join(" AND "), params };
  }

  // ── Arm 1: VECTOR. ORDER BY + LIMIT on distance keeps the HNSW index in play;
  //    we dedupe chunk rows to the closest chunk per product afterward.
  const [queryVec] = await embed([query]);
  const vf = productFilters(2); // $1 is the query vector
  const vParams: any[] = [toVectorLiteral(queryVec), ...vf.params, POOL];
  const vSql = `
    SELECT ${PRODUCT_COLS},
           e.chunk_type AS matched_chunk, e.content AS matched_content,
           (e.embedding <=> $1::vector) AS distance
    FROM embeddings e
    JOIN products p ON p.id = e.product_id
    ${vf.clause ? `WHERE ${vf.clause}` : ""}
    ORDER BY e.embedding <=> $1::vector
    LIMIT $${vParams.length}`;
  const vRows = (await pool.query(vSql, vParams)).rows;

  const vSeen = new Set<number>();
  const vList: RetrievedProduct[] = [];
  for (const r of vRows) {
    const id = Number(r.id);
    if (vSeen.has(id)) continue; // first row per product is its closest chunk
    vSeen.add(id);
    vList.push(rowToProduct(r));
  }

  // ── Arm 2: KEYWORD. Full-text match + rank over the generated search_tsv column.
  const kf = productFilters(2); // $1 is the query text
  const kParams: any[] = [query, ...kf.params, POOL];
  const kSql = `
    SELECT ${PRODUCT_COLS},
           ts_rank_cd(p.search_tsv, websearch_to_tsquery('english', $1)) AS rank
    FROM products p
    WHERE p.search_tsv @@ websearch_to_tsquery('english', $1)
      ${kf.clause ? `AND ${kf.clause}` : ""}
    ORDER BY rank DESC
    LIMIT $${kParams.length}`;
  const kRows = (await pool.query(kSql, kParams)).rows;
  const kList: RetrievedProduct[] = kRows.map(rowToProduct);

  // ── Fuse with Reciprocal Rank Fusion: each arm contributes 1/(K + rank).
  const K = 60;
  const byId = new Map<number, RetrievedProduct>();
  const rrf = new Map<number, number>();
  const inKeyword = new Set<number>();

  vList.forEach((p, i) => {
    byId.set(p.id, p); // vector rows carry matched_chunk/content — prefer them
    rrf.set(p.id, (rrf.get(p.id) ?? 0) + 1 / (K + i + 1));
  });
  kList.forEach((p, i) => {
    if (!byId.has(p.id)) byId.set(p.id, p);
    rrf.set(p.id, (rrf.get(p.id) ?? 0) + 1 / (K + i + 1));
    inKeyword.add(p.id);
  });

  // ── Relevance gate. Keep a product if its tokens matched (keyword hit ⇒ relevant)
  //    OR its vector distance is within the adaptive cap. This drops the vague
  //    vector-only padding (tables for "chairs") without dropping exact hits.
  const vDistances = vList.map((p) => p.distance).filter((d): d is number => d != null);
  const bestDistance = vDistances.length ? Math.min(...vDistances) : 0;
  const effectiveCap = Math.min(maxDistance, bestDistance + RELEVANCE_WINDOW);

  const fused = [...byId.values()].filter(
    (p) => inKeyword.has(p.id) || (p.distance != null && p.distance <= effectiveCap)
  );
  fused.sort((a, b) => (rrf.get(b.id) ?? 0) - (rrf.get(a.id) ?? 0));

  // ── Optional LLM re-rank over the fused shortlist, then trim to `limit`.
  if (rerankResults && fused.length > 1) {
    const shortlist = fused.slice(0, Math.min(fused.length, limit * 2));
    const order = await rerank(
      query,
      shortlist.map((p) => ({
        id: p.id,
        text: `${p.title}${p.brand ? ` — ${p.brand}` : ""}. ${(p.description ?? "").slice(0, 200)}`,
      }))
    );
    const pos = new Map(order.map((id, i) => [id, i] as const));
    shortlist.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    return shortlist.slice(0, limit);
  }

  return fused.slice(0, limit);
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
            in_stock, rating_avg, rating_count, use_cases, attributes, crawled_at
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
    crawled_at: toIso(r.crawled_at),
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
            in_stock, rating_avg, rating_count, use_cases, attributes, crawled_at
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
    crawled_at: toIso(r.crawled_at),
  }));
}
