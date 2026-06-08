// sites.ts — multi-store support via pluggable "site adapters".
//
// Each adapter teaches the engine a store's quirks (how to spot a product URL,
// how to build a search URL, how product links look). The extraction itself stays
// portable (crawler.ts is JSON-LD-first), so an adapter is just a little config.
//
// getAdapter(url) detects the right adapter from the URL:
//   • IKEA            — matched by host
//   • Generic Shopify — detected by probing /products.json (works on ANY Shopify store)
//   • Generic         — best-effort fallback (relies on schema.org JSON-LD)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface SiteAdapter {
  name: string; // human-readable store name (used in prompts)
  isProductUrl(url: string): boolean; // PDP vs listing/homepage
  buildSearchUrl(siteUrl: string, term: string): string; // how to search this store
  productLinkPattern: RegExp; // how product links look (for discovery)
}

/** Tidy a host into a display name, e.g. "www.deathwishcoffee.com" → "deathwishcoffee.com". */
function hostName(siteUrl: string): string {
  try {
    return new URL(siteUrl).host.replace(/^www\./, "");
  } catch {
    return "this store";
  }
}

// ── IKEA ─────────────────────────────────────────────────────────────────────
const IKEA: SiteAdapter = {
  name: "IKEA",
  isProductUrl: (url) => /\/p\/[^/]+-\d+\/?($|\?)/.test(url),
  buildSearchUrl: (_site, term) =>
    `https://www.ikea.com/us/en/search/?q=${encodeURIComponent(term)}`,
  productLinkPattern: /\/p\/[^/]+-\d+\/?($|\?)/,
};

// ── Generic Shopify (any Shopify store) ──────────────────────────────────────
function shopifyAdapter(siteUrl: string): SiteAdapter {
  const origin = new URL(siteUrl).origin;
  return {
    name: hostName(siteUrl),
    isProductUrl: (url) => /\/products\/[^/?#]+/.test(url),
    buildSearchUrl: (_site, term) => `${origin}/search?q=${encodeURIComponent(term)}`,
    productLinkPattern: /\/products\/[^/?#]+/,
  };
}

// ── Generic fallback (unknown sites with schema.org JSON-LD) ──────────────────
function genericAdapter(siteUrl: string): SiteAdapter {
  let origin = "";
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    /* ignore */
  }
  return {
    name: hostName(siteUrl),
    isProductUrl: (url) => /\/(p|product|products|dp|item)\/[^/?#]+/.test(url),
    buildSearchUrl: (_site, term) => `${origin}/search?q=${encodeURIComponent(term)}`,
    productLinkPattern: /\/(p|product|products|dp|item)\/[^/?#]+/,
  };
}

/**
 * getAdapter — pick the right adapter for a URL.
 * IKEA is matched by host; Shopify is detected by probing /products.json; otherwise
 * we fall back to the generic adapter.
 */
export async function getAdapter(siteUrl: string): Promise<SiteAdapter> {
  let host = "";
  try {
    host = new URL(siteUrl).host;
  } catch {
    return genericAdapter(siteUrl);
  }

  if (host.includes("ikea.com")) return IKEA;

  // Shopify probe: every Shopify store exposes /products.json.
  try {
    const origin = new URL(siteUrl).origin;
    const res = await fetch(`${origin}/products.json?limit=1`, {
      headers: { "User-Agent": UA },
    });
    if (res.ok) {
      const data = (await res.json()) as { products?: unknown };
      if (Array.isArray(data.products)) return shopifyAdapter(siteUrl);
    }
  } catch {
    /* not Shopify (or blocked) — fall through */
  }

  return genericAdapter(siteUrl);
}
