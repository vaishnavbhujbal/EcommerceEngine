// ingest.ts — the pipeline conductor: crawl → AEO + GEO → embed → store.
//
// This is the only file that wires crawler.ts + ai.ts + db.ts together. In the
// lightweight prompt+URL flow it runs ON-DEMAND for the URL the user supplies:
//   - a product URL  → ingest that one product
//   - a listing URL  → discover a few product URLs and ingest each
//
// Correctness rules baked in:
//   #1 Never invent catalog facts — AEO/GEO prompts may only use crawled data;
//      price/SKU/stock are stored from the crawl, never generated.
//   #2 Semantic content is embedded; volatile price/stock stay as SQL columns.

import { pool } from "./db.js";
import { embed, complete } from "./ai.js";
import {
  crawlPdp,
  discoverProductUrls,
  type CrawledProduct,
  type CrawledReview,
  type ProductSpec,
} from "./crawler.js";
import { getAdapter, type SiteAdapter } from "./sites.js";

// Progress callback so routes.ts can stream SSE events to the frontend.
export type ProgressFn = (event: { phase: string; message: string; productId?: number }) => void;
const noop: ProgressFn = () => {};

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ingestUrl — ingest a single product URL, or a few products from a listing URL.
 * The store adapter (detected from the URL) decides PDP-vs-listing and how product
 * links look. Returns a summary array (one entry per ingested product).
 */
export async function ingestUrl(
  url: string,
  onProgress: ProgressFn = noop
): Promise<Array<{ productId: number; title: string }>> {
  const adapter = await getAdapter(url);

  if (adapter.isProductUrl(url)) {
    onProgress({ phase: "crawl", message: `Crawling product page…` });
    const product = await crawlPdp(url);
    const summary = await ingestProduct(product, onProgress);
    return [summary];
  }

  // Listing/search page: discover a handful of PDPs, then ingest each.
  onProgress({ phase: "discover", message: `Discovering products on listing page…` });
  const urls = await discoverProductUrls(url, adapter.productLinkPattern.source, 8);
  onProgress({ phase: "discover", message: `Found ${urls.length} products.` });

  const results: Array<{ productId: number; title: string }> = [];
  for (const pdpUrl of urls) {
    onProgress({ phase: "crawl", message: `Crawling ${pdpUrl}` });
    const product = await crawlPdp(pdpUrl);
    results.push(await ingestProduct(product, onProgress));
  }
  return results;
}

/** Cheap existence check so live search can skip the expensive AEO/GEO for
 *  products we've already enriched (we just refresh their live price/stock). */
async function productExists(url: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM products WHERE source_url = $1`, [url]);
  return rows.length > 0;
}

/**
 * deriveSearchTerm — turn a natural-language shopping prompt into a concise site
 * search query (e.g. "a comfy office chair under $150" → "office chair").
 */
export async function deriveSearchTerm(prompt: string): Promise<string> {
  const raw = await complete({
    system:
      "Extract a concise product search query (2-4 words) for a shopping website search " +
      "from the user's request. Reply with ONLY the query text — no quotes, no extra words.",
    user: prompt,
    temperature: 0,
  });
  return raw.trim().replace(/^["']+|["']+$/g, "").slice(0, 60) || prompt.slice(0, 40);
}

/**
 * liveSearch — fetch FRESH products from the live site according to the prompt.
 *
 * Derives a search term, live-crawls the store's search results (via its adapter),
 * then for each product runs the full pipeline (crawl → AEO + GEO → embed) if it's
 * new, or just refreshes live price/stock if we've already enriched it. Products land
 * in the catalog so the subsequent retrieve()/ground step answers on live data.
 */
export async function liveSearch(
  prompt: string,
  siteUrl: string,
  adapter: SiteAdapter,
  onProgress: ProgressFn = noop,
  limit = 4
): Promise<void> {
  const term = await deriveSearchTerm(prompt);
  onProgress({ phase: "live-search", message: `Searching ${adapter.name} live for "${term}"…` });

  const searchUrl = adapter.buildSearchUrl(siteUrl, term);
  const urls = await discoverProductUrls(searchUrl, adapter.productLinkPattern.source, limit);
  onProgress({ phase: "live-search", message: `Found ${urls.length} live products — fetching…` });

  // Fetch/enrich the products in parallel for speed.
  await Promise.all(
    urls.map(async (url) => {
      try {
        if (await productExists(url)) {
          await refreshLiveFields(url); // already has AEO/GEO — just refresh live fields
        } else {
          await ingestProduct(await crawlPdp(url), onProgress); // full crawl + AEO + GEO + embed
        }
      } catch (err) {
        onProgress({ phase: "live-search", message: `Skipped one product: ${(err as Error).message}` });
      }
    })
  );
}

/**
 * refreshLiveFields — re-crawl a PDP and update ONLY the volatile fields
 * (price/stock/rating). Cheap (no LLM calls, no re-embedding) — used by rag.ts at
 * answer-time so the price/stock in an answer is genuinely live, not crawl-stale.
 */
export async function refreshLiveFields(url: string): Promise<void> {
  const c = await crawlPdp(url);
  await pool.query(
    `UPDATE products
       SET price_cents = $1, currency = $2, in_stock = $3,
           rating_avg = $4, rating_count = $5, crawled_at = now()
     WHERE source_url = $6`,
    [c.price_cents, c.currency, c.in_stock, c.rating_avg, c.rating_count, url]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-product pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ingestProduct — persist one crawled product, generate AEO + GEO, embed, store.
 */
export async function ingestProduct(
  crawled: CrawledProduct,
  onProgress: ProgressFn = noop
): Promise<{ productId: number; title: string }> {
  // 1) UPSERT the core product row (volatile price/stock live here as columns).
  //    Specs go into the `attributes` JSONB so rag.ts can quote exact facts.
  const productId = await upsertProduct(crawled);
  onProgress({ phase: "store", message: `Stored "${crawled.title}"`, productId });

  // 1b) Persist crawled buyer reviews (#1). These also ground the enrichment below,
  //     so the AEO Q&A reflect real buyer concerns, not the model's guesses.
  await storeReviews(productId, crawled.reviews);

  // 2) AEO + GEO in ONE grounded LLM call (GEO rewrite + use-cases + AEO Q&A).
  //    Combining them halves the per-product model latency.
  onProgress({ phase: "enrich", message: "Generating AEO + GEO…", productId });
  const enrich = await generateEnrichment(crawled);
  if (enrich.use_cases.length > 0) {
    await pool.query(`UPDATE products SET use_cases = $1 WHERE id = $2`, [enrich.use_cases, productId]);
  }
  // storeAeo returns the inserted row ids, aligned with enrich.qa, so the embedded
  // faq chunks can link back to their source Q&A (powers the #6 direct-answer path).
  const aeoIds = await storeAeo(productId, enrich.qa);

  // 2b) Generate + store schema.org JSON-LD (#4) — Product + FAQPage assembled
  //     deterministically from grounded facts + the AEO Q&A. An exportable asset.
  const jsonld = buildJsonLd(crawled, enrich.qa);
  await pool.query(`UPDATE products SET jsonld = $1 WHERE id = $2`, [JSON.stringify(jsonld), productId]);

  // 3) Build semantic chunks, embed in one batch, replace this product's vectors.
  onProgress({ phase: "embed", message: "Embedding semantic content…", productId });
  const chunks = buildChunks(crawled, enrich.rewritten_description, enrich.qa, aeoIds);
  await embedAndStore(productId, chunks);

  onProgress({ phase: "done", message: `Ingested "${crawled.title}"`, productId });
  return { productId, title: crawled.title };
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────

/** UPSERT by source_url (the crawler's natural key). Returns the product id. */
async function upsertProduct(p: CrawledProduct): Promise<number> {
  const attributes = JSON.stringify({ specs: p.specs });
  const { rows } = await pool.query(
    `INSERT INTO products
       (source_url, sku, title, brand, description, attributes,
        price_cents, currency, in_stock, rating_avg, rating_count, crawled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (source_url) DO UPDATE SET
       sku=EXCLUDED.sku, title=EXCLUDED.title, brand=EXCLUDED.brand,
       description=EXCLUDED.description, attributes=EXCLUDED.attributes,
       price_cents=EXCLUDED.price_cents, currency=EXCLUDED.currency,
       in_stock=EXCLUDED.in_stock, rating_avg=EXCLUDED.rating_avg,
       rating_count=EXCLUDED.rating_count, crawled_at=now()
     RETURNING id`,
    [
      p.source_url,
      p.sku,
      p.title,
      p.brand,
      p.description,
      attributes,
      p.price_cents,
      p.currency,
      p.in_stock,
      p.rating_avg,
      p.rating_count,
    ]
  );
  return rows[0].id as number;
}

/** Replace this product's buyer reviews (delete + insert, so re-ingest is clean). */
async function storeReviews(productId: number, reviews: CrawledReview[]): Promise<void> {
  await pool.query(`DELETE FROM reviews WHERE product_id = $1`, [productId]);
  for (const r of reviews) {
    await pool.query(
      `INSERT INTO reviews (product_id, rating, title, body) VALUES ($1,$2,$3,$4)`,
      [productId, r.rating, r.title, r.body]
    );
  }
}

/** Replace this product's AEO answers (delete + insert, so re-ingest is clean).
 *  Returns the inserted row ids in the SAME order as `qa`, so the caller can link
 *  each embedded faq chunk to its source Q&A (#6 direct-answer). */
async function storeAeo(productId: number, qa: AeoPair[]): Promise<number[]> {
  await pool.query(`DELETE FROM aeo_answers WHERE product_id = $1`, [productId]);
  const ids: number[] = [];
  for (const item of qa) {
    const { rows } = await pool.query(
      `INSERT INTO aeo_answers (product_id, question, answer, answer_type)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [productId, item.question, item.answer, item.answer_type]
    );
    ids.push(rows[0].id as number);
  }
  return ids;
}

/** Embed all chunk contents in one batch, then replace this product's vectors. */
async function embedAndStore(productId: number, chunks: Chunk[]): Promise<void> {
  if (chunks.length === 0) return;
  const vectors = await embed(chunks.map((c) => c.content));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM embeddings WHERE product_id = $1`, [productId]);
    for (let i = 0; i < chunks.length; i++) {
      // pgvector accepts a text literal like "[0.1,0.2,...]"; cast it explicitly.
      const literal = `[${vectors[i].join(",")}]`;
      await client.query(
        `INSERT INTO embeddings (product_id, chunk_type, content, embedding, aeo_answer_id)
         VALUES ($1,$2,$3,$4::vector,$5)`,
        [productId, chunks[i].chunk_type, chunks[i].content, literal, chunks[i].aeo_answer_id ?? null]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AEO + GEO generation (the interviewer's two deliverables)
// ─────────────────────────────────────────────────────────────────────────────

interface AeoPair {
  question: string;
  answer: string;
  answer_type: string;
}

/** Compact, factual context block the model is allowed to use — nothing else. */
function factsBlock(p: CrawledProduct): string {
  const specs = p.specs.map((s) => `${s.name}: ${s.value}`).join("; ");
  // Real buyer quotes (#1): these let the AEO Q&A target genuine concerns/praise
  // ("is it sturdy?", "good for small spaces") instead of invented questions.
  const reviewQuotes = p.reviews
    .slice(0, 8)
    .map((r) => `- ${r.body}`)
    .join("\n");
  return [
    `Title: ${p.title}`,
    p.brand ? `Brand: ${p.brand}` : "",
    p.description ? `Description: ${p.description}` : "",
    specs ? `Specs: ${specs}` : "",
    p.rating_avg != null ? `Rating: ${p.rating_avg} from ${p.rating_count} reviews` : "",
    reviewQuotes
      ? `Buyer reviews (real quotes — use these to shape questions and reflect common ` +
        `concerns/praise; do NOT state facts that aren't supported here or above):\n${reviewQuotes}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * buildJsonLd — assemble schema.org Product + FAQPage JSON-LD (#4).
 *
 * Deterministic: every value traces to a crawled fact or a grounded AEO answer — no
 * model call, nothing invented. This is the exportable "answer-engine asset": exactly
 * the markup Google SGE / Perplexity ingest, so a retailer could publish it as-is.
 * The two objects are wrapped in an @graph so it's one pasteable block.
 */
function buildJsonLd(p: CrawledProduct, qa: AeoPair[]): unknown {
  const product: Record<string, unknown> = {
    "@type": "Product",
    name: p.title,
    url: p.source_url,
    ...(p.brand ? { brand: { "@type": "Brand", name: p.brand } } : {}),
    ...(p.sku ? { sku: p.sku } : {}),
    ...(p.description ? { description: p.description } : {}),
    ...(p.image ? { image: p.image } : {}),
    ...(p.specs.length
      ? {
          additionalProperty: p.specs.map((s) => ({
            "@type": "PropertyValue",
            name: s.name,
            value: s.value,
          })),
        }
      : {}),
    ...(p.price_cents != null
      ? {
          offers: {
            "@type": "Offer",
            price: (p.price_cents / 100).toFixed(2),
            priceCurrency: p.currency || "USD",
            url: p.source_url,
            ...(p.in_stock === true
              ? { availability: "https://schema.org/InStock" }
              : p.in_stock === false
              ? { availability: "https://schema.org/OutOfStock" }
              : {}),
          },
        }
      : {}),
    ...(p.rating_avg != null
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: p.rating_avg,
            ...(p.rating_count != null ? { reviewCount: p.rating_count } : {}),
          },
        }
      : {}),
  };

  const graph: unknown[] = [product];
  if (qa.length) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: qa.map((x) => ({
        "@type": "Question",
        name: x.question,
        acceptedAnswer: { "@type": "Answer", text: x.answer },
      })),
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

interface Enrichment {
  rewritten_description: string;
  use_cases: string[];
  qa: AeoPair[];
}

/**
 * generateEnrichment — AEO + GEO in ONE grounded LLM call (was two).
 * Returns the GEO rewrite + use-cases AND the AEO Q&A pairs together. Grounded only
 * in the provided facts; never invents price/SKU/stock.
 */
async function generateEnrichment(p: CrawledProduct): Promise<Enrichment> {
  const raw = await complete({
    system:
      "You perform AEO (Answer Engine Optimization) and GEO (Generative Engine Optimization) " +
      "for an ecommerce catalog, grounded ONLY in the provided facts — never invent specs, " +
      "prices, SKUs, or stock. Produce three things: " +
      "(1) rewritten_description: entity-rich copy dense with attributes, materials, audience, " +
      "and concrete use-cases; " +
      "(2) use_cases: an array of short concrete use-cases; " +
      "(3) qa: 5-6 grounded shopper question/answer pairs — when buyer reviews are provided, " +
      "prioritize the real concerns and praise they raise; for questions needing price or " +
      "live stock, answer generally and note they are confirmed live at answer-time; vary " +
      "answer_type (availability, sizing, spec, usecase, returns, care). " +
      'Return JSON: {"rewritten_description": string, "use_cases": string[], ' +
      '"qa": [{"question": string, "answer": string, "answer_type": string}]}.',
    user: factsBlock(p),
    json: true,
    temperature: 0.4,
  });
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed.qa) ? parsed.qa : [];
    return {
      rewritten_description: String(parsed.rewritten_description || p.description || ""),
      use_cases: Array.isArray(parsed.use_cases) ? parsed.use_cases.map(String).slice(0, 8) : [],
      qa: list
        .filter((x: any) => x && x.question && x.answer)
        .slice(0, 6)
        .map((x: any) => ({
          question: String(x.question),
          answer: String(x.answer),
          answer_type: String(x.answer_type || "general"),
        })),
    };
  } catch {
    // Malformed JSON → fall back to the original description, no use-cases/Q&A.
    return { rewritten_description: p.description || "", use_cases: [], qa: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunking — what gets embedded (semantic only; never price/stock)
// ─────────────────────────────────────────────────────────────────────────────

interface Chunk {
  chunk_type: string;
  content: string;
  aeo_answer_id?: number | null; // set only for faq chunks → links to aeo_answers (#6)
}

function specsToText(specs: ProductSpec[]): string {
  return specs.map((s) => `${s.name}: ${s.value}`).join("; ");
}

/** Build the per-product embedding chunks, keyed by facet for targeted retrieval.
 *  `aeoIds` aligns 1:1 with `qa`, so each faq chunk records which aeo_answers row it
 *  came from (used by the #6 direct-answer short-circuit at query time). */
function buildChunks(p: CrawledProduct, geoRewrite: string, qa: AeoPair[], aeoIds: number[] = []): Chunk[] {
  const chunks: Chunk[] = [];
  if (p.description) chunks.push({ chunk_type: "description", content: p.description });
  if (geoRewrite) chunks.push({ chunk_type: "geo_content", content: geoRewrite });
  if (p.specs.length > 0) chunks.push({ chunk_type: "spec", content: specsToText(p.specs) });
  qa.forEach((item, i) => {
    chunks.push({
      chunk_type: "faq",
      content: `${item.question} ${item.answer}`,
      aeo_answer_id: aeoIds[i] ?? null,
    });
  });
  return chunks;
}
