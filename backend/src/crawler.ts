// crawler.ts — the headless-browser crawler (Playwright + Chromium).
//
// Role in the pipeline: given a URL the user supplies (prompt + URL flow), render
// the page like a real browser and EXTRACT structured product data. It does NOT
// touch the database or call the LLM — it just returns clean data that ingest.ts
// (normalize → AEO/GEO → embed → store) and rag.ts consume.
//
// Target: IKEA (www.ikea.com). Confirmed crawlable, and its product pages expose
// a reliable schema.org/Product JSON-LD block (name, sku, price, availability,
// aggregateRating). We prefer that structured data and fall back to DOM selectors.
//
// Extraction priority (design doc §7):
//   1) JSON-LD schema.org/Product  — most reliable
//   2) DOM selectors               — fallback when JSON-LD is absent

import { chromium, type Browser } from "playwright";

// A realistic desktop UA. Headless Chromium's default UA advertises "HeadlessChrome",
// which some sites treat differently; a normal UA keeps us looking like a browser.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// The shape we hand back to the rest of the pipeline. This maps cleanly onto the
// `products` table, but the crawler stays DB-agnostic — it only extracts.
export interface CrawledProduct {
  source_url: string;
  title: string;
  sku: string | null;
  brand: string | null;
  description: string | null;
  price_cents: number | null; // integer cents, parsed from the price string
  currency: string | null;
  in_stock: boolean | null;
  rating_avg: number | null;
  rating_count: number | null; // powers the "Most Popular" signal
  image: string | null;
  specs: ProductSpec[]; // material/dimension facts — enables exact, grounded answers
  extraction_method: "json-ld" | "dom"; // which path produced the data (debugging)
}

/** A single spec/attribute, e.g. { name: "Table top", value: "Particleboard, Birch veneer" }. */
export interface ProductSpec {
  name: string;
  value: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser lifecycle — one shared Chromium for the whole process.
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser | null = null;

/** Lazily launch (and reuse) a single headless Chromium. */
export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    // --disable-http2 avoids occasional HTTP/2 handshake issues some CDNs throw
    // at automated clients; IKEA renders fine with it.
    browser = await chromium.launch({ headless: true, args: ["--disable-http2"] });
  }
  return browser;
}

/** Close the shared browser. ingest.ts should call this at the end of a run so we
 *  don't leak a Chromium process (important on a 512 MB Render instance). */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers (exported for unit-testing / reuse).
// ─────────────────────────────────────────────────────────────────────────────

/** "$149.99" / "149.99" / "1,149.00" → 14999 (integer cents). null if unparseable. */
export function priceToCents(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const num = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/** schema.org availability URL/string → boolean in-stock (null if unknown). */
function parseAvailability(av: unknown): boolean | null {
  if (av == null) return null;
  const s = String(av).toLowerCase();
  if (s.includes("instock") || s.includes("in_stock")) return true;
  if (s.includes("outofstock") || s.includes("soldout") || s.includes("discontinued")) return false;
  return null;
}

/** IKEA's JSON-LD image can be a string or an ImageObject ({contentUrl|url}). */
function pickImage(image: unknown): string | null {
  if (!image) return null;
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return pickImage(image[0]);
  if (typeof image === "object") {
    const o = image as Record<string, unknown>;
    return (o.contentUrl as string) || (o.url as string) || null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: crawl a single product page (PDP).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * crawlPdp — render one IKEA product page and extract a CrawledProduct.
 *
 * Renders with Playwright (so client-side JS runs), then pulls data in priority
 * order: JSON-LD first, DOM fallback. Retries the navigation once on failure.
 */
export async function crawlPdp(url: string): Promise<CrawledProduct> {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  try {
    // Navigate with one retry + backoff — transient network/CDN hiccups happen.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await page.waitForTimeout(2000);
      }
    }
    if (lastErr) throw lastErr;

    // Give client-side hydration a moment (price/rating can render after load).
    await page.waitForTimeout(2500);

    // Scroll so lazy-loaded sections (specs/measurements) render into the DOM.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 1400));
      await page.waitForTimeout(700);
    }

    // Specs come from the DOM regardless of the JSON-LD path (IKEA's JSON-LD
    // omits them). IKEA renders material/dimension facts as <dt>/<dd> pairs.
    const specs = await page.evaluate(() => {
      const pairs: { name: string; value: string }[] = [];
      for (const dt of Array.from(document.querySelectorAll("dt"))) {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === "DD") {
          const name = (dt.textContent || "").replace(/\s+/g, " ").replace(/:$/, "").trim();
          const value = (dd.textContent || "").replace(/\s+/g, " ").trim();
          if (name && value) pairs.push({ name, value });
        }
      }
      // De-dupe by name, cap to keep the embedded spec doc tight.
      const seen = new Set<string>();
      return pairs
        .filter((p) => {
          const k = p.name.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 15);
    });

    // 1) Try JSON-LD. Runs in the page context; returns a plain object or null.
    const fromJsonLd = await page.evaluate(() => {
      for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try {
          const data = JSON.parse(node.textContent || "");
          // Real-world JSON-LD comes as an object, an array, or an @graph wrapper.
          const candidates = Array.isArray(data) ? data : (data as any)["@graph"] || [data];
          for (const obj of candidates) {
            const type = obj && obj["@type"];
            const types = Array.isArray(type) ? type : [type];
            if (types.includes("Product")) {
              const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
              return {
                name: obj.name ?? null,
                sku: obj.sku ?? obj.mpn ?? null,
                brand: obj.brand?.name ?? obj.brand ?? null,
                description: obj.description ?? null,
                price: offer?.price ?? null,
                currency: offer?.priceCurrency ?? null,
                availability: offer?.availability ?? null,
                rating: obj.aggregateRating?.ratingValue ?? null,
                reviewCount:
                  obj.aggregateRating?.reviewCount ?? obj.aggregateRating?.ratingCount ?? null,
                image: obj.image ?? null,
              };
            }
          }
        } catch {
          // Ignore a malformed JSON-LD block and try the next one.
        }
      }
      return null;
    });

    if (fromJsonLd && fromJsonLd.name) {
      return {
        source_url: url,
        title: String(fromJsonLd.name).replace(/\s+/g, " ").trim(),
        sku: fromJsonLd.sku ? String(fromJsonLd.sku) : null,
        brand: fromJsonLd.brand ? String(fromJsonLd.brand) : null,
        description: fromJsonLd.description ? String(fromJsonLd.description).trim() : null,
        price_cents: priceToCents(fromJsonLd.price),
        currency: fromJsonLd.currency ? String(fromJsonLd.currency) : null,
        in_stock: parseAvailability(fromJsonLd.availability),
        rating_avg: fromJsonLd.rating != null ? Number(fromJsonLd.rating) : null,
        rating_count: fromJsonLd.reviewCount != null ? Number(fromJsonLd.reviewCount) : null,
        image: pickImage(fromJsonLd.image),
        specs,
        extraction_method: "json-ld",
      };
    }

    // 2) DOM fallback — used only if JSON-LD is missing/empty.
    const fromDom = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? "";
      const priceMatch = bodyText.match(/\$[\d,]+\.?\d{0,2}/);
      return {
        title: document.querySelector("h1")?.innerText?.replace(/\s+/g, " ").trim() || null,
        description: document.querySelector('meta[name="description"]')?.getAttribute("content") || null,
        priceText: priceMatch ? priceMatch[0] : null,
        // crude in-stock heuristic from visible text
        inStock: /in stock|add to cart|add to bag/i.test(bodyText)
          ? true
          : /out of stock|sold out/i.test(bodyText)
          ? false
          : null,
        image: document.querySelector('meta[property="og:image"]')?.getAttribute("content") || null,
      };
    });

    return {
      source_url: url,
      title: fromDom.title || "(unknown product)",
      sku: null,
      brand: null, // brand normally comes from JSON-LD; unknown in the DOM fallback
      description: fromDom.description ? fromDom.description.trim() : null,
      price_cents: priceToCents(fromDom.priceText),
      currency: fromDom.priceText ? "USD" : null,
      in_stock: fromDom.inStock,
      rating_avg: null,
      rating_count: null,
      image: fromDom.image,
      specs,
      extraction_method: "dom",
    };
  } finally {
    // Close the page+context (NOT the shared browser) so memory is reclaimed.
    await context.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery: when the supplied URL is a category/search listing, collect a few
// product URLs to crawl (powers comparison / cross-sell in the prompt+URL flow).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * discoverProductUrls — render a listing/search page, scroll to trigger lazy
 * tiles, and return up to `limit` product (PDP) URLs that match the store's
 * product-link pattern.
 *
 * `productLinkPatternSource` is the adapter's RegExp source (a string), because a
 * RegExp object can't cross into the page's evaluate() context — we rebuild it there.
 */
export async function discoverProductUrls(
  listingUrl: string,
  productLinkPatternSource: string,
  limit = 12
): Promise<string[]> {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Scroll a few times so lazy-loaded product tiles render.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 1500));
      await page.waitForTimeout(1200);
    }

    const urls = await page.evaluate((patternSource) => {
      const re = new RegExp(patternSource);
      const links = Array.from(document.querySelectorAll("a"))
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h) => re.test(h));
      return [...new Set(links)];
    }, productLinkPatternSource);

    return urls.slice(0, limit);
  } finally {
    await context.close();
  }
}
