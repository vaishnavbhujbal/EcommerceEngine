import { useState } from "react";
import {
  Search,
  Sparkles,
  Link2,
  MessageSquareText,
  Loader2,
  CheckCircle2,
  XCircle,
  Star,
  ExternalLink,
  Tag,
  ShoppingBag,
  Check,
  AlertCircle,
  Globe,
  ShieldCheck,
  Clock,
  Zap,
  Code2,
  Copy,
} from "lucide-react";
import { postChat, type ChatEvent, type ProductCard, type WebInsights, type QuickAnswer } from "./api";

const SAMPLE_URL = "https://www.ikea.com/";

function formatPrice(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  const sym = !currency || currency === "USD" ? "$" : `${currency} `;
  return `${sym}${(cents / 100).toFixed(2)}`;
}

// renderRich — turn a plain string into React nodes, making any Markdown link
// [label](url) or bare http(s) URL a clickable <a>. Used for the grounded answer
// (the model now cites products as Markdown links) and the web-insight bullets.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)]+)/g;
function renderRich(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0; // reset the shared global-flag regex before each use
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const label = m[1] ?? m[3]; // markdown label, else the raw URL itself
    const href = m[2] ?? m[3];
    nodes.push(
      <a
        key={key++}
        href={href}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-700"
      >
        {label}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// verifiedLabel — turn a crawl timestamp into an honest freshness label. We only
// claim "Verified live" when the crawl was within ~2 minutes (the anchor and live
// search results are re-crawled at answer-time); older cached cards say how long
// ago they were checked. This is the thing a generic LLM can never show.
function verifiedLabel(iso: string | null): { text: string; live: boolean } | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  const ageMin = Math.floor((Date.now() - t) / 60000);
  if (ageMin <= 2) {
    const time = new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return { text: `Verified live · ${time}`, live: true };
  }
  if (ageMin < 60) return { text: `Checked ${ageMin}m ago`, live: false };
  const ageHr = Math.floor(ageMin / 60);
  if (ageHr < 24) return { text: `Checked ${ageHr}h ago`, live: false };
  return { text: `Checked ${Math.floor(ageHr / 24)}d ago`, live: false };
}

function StarRating({ avg, count }: { avg: number | null; count: number | null }) {
  if (avg == null) return null;
  const full = Math.round(avg);
  return (
    <span className="flex items-center gap-1 text-xs text-slate-500" title={`${avg} / 5`}>
      <span className="flex">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star
            key={i}
            className={`h-3.5 w-3.5 ${
              i < full ? "fill-amber-400 text-amber-400" : "fill-slate-200 text-slate-200"
            }`}
          />
        ))}
      </span>
      <span className="font-medium text-slate-600">{avg}</span>
      {count != null && <span className="text-slate-400">({count.toLocaleString()})</span>}
    </span>
  );
}

function Card({ p }: { p: ProductCard }) {
  const isAnchor = p.role === "anchor";
  const highlights = p.highlights ?? []; // tolerate responses from an un-restarted backend
  return (
    <div className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md">
      {/* Badges */}
      <div className="mb-3 flex items-center justify-between">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
            isAnchor ? "bg-indigo-50 text-indigo-700" : "bg-violet-50 text-violet-700"
          }`}
        >
          {isAnchor ? <Tag className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
          {isAnchor ? "This product" : "Suggestion"}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
            p.in_stock
              ? "bg-emerald-50 text-emerald-700"
              : p.in_stock === false
              ? "bg-rose-50 text-rose-600"
              : "bg-slate-100 text-slate-500"
          }`}
        >
          {p.in_stock ? (
            <CheckCircle2 className="h-3 w-3" />
          ) : p.in_stock === false ? (
            <XCircle className="h-3 w-3" />
          ) : null}
          {p.in_stock ? "In stock" : p.in_stock === false ? "Out of stock" : "Stock?"}
        </span>
      </div>

      {/* Title */}
      <h3 className="text-[15px] font-semibold leading-snug text-slate-800">{p.title}</h3>

      {/* Price + rating */}
      <div className="mt-3 flex items-end justify-between">
        <span className="text-2xl font-bold tracking-tight text-slate-900">
          {formatPrice(p.price_cents, p.currency)}
        </span>
        <StarRating avg={p.rating_avg} count={p.rating_count} />
      </div>

      {/* Live-verified badge — the trust signal a generic LLM can't produce */}
      {(() => {
        const v = verifiedLabel(p.verified_at);
        if (!v) return null;
        return (
          <div
            className={`mt-2 inline-flex items-center gap-1 text-[11px] font-medium ${
              v.live ? "text-emerald-600" : "text-slate-400"
            }`}
            title={p.verified_at ?? undefined}
          >
            {v.live ? <ShieldCheck className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
            {v.text}
          </div>
        );
      })()}

      {/* Highlights as bullet points */}
      {highlights.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-3">
          {highlights.map((h, i) => (
            <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-slate-600">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
              <span>{h}</span>
            </li>
          ))}
        </ul>
      )}

      {/* CTA */}
      <a
        href={p.url}
        target="_blank"
        rel="noreferrer"
        className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-700"
      >
        View product <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

// JsonLdPanel — collapsible, copyable schema.org block (#4). This is the
// exportable "answer-engine asset" generated from the catalog at ingest time.
function JsonLdPanel({ data }: { data: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(data, null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  };
  return (
    <details className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-600">
        <Code2 className="h-4 w-4" /> Structured data (JSON-LD)
        <span className="ml-1 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-slate-500">
          exportable · Product + FAQPage
        </span>
      </summary>
      <div className="mt-3">
        <button
          onClick={copy}
          className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-500" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy JSON-LD
            </>
          )}
        </button>
        <pre className="max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
          {text}
        </pre>
      </div>
    </details>
  );
}

export default function App() {
  const [url, setUrl] = useState(SAMPLE_URL);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string>("");
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [web, setWeb] = useState<WebInsights | null>(null);
  const [quick, setQuick] = useState<QuickAnswer | null>(null);
  const [jsonld, setJsonld] = useState<unknown | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onAsk() {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    setAnswer("");
    setProducts([]);
    setWeb(null);
    setQuick(null);
    setJsonld(null);
    setPhase("Starting…");

    await postChat({ query: query.trim(), url: url.trim() || undefined }, (e: ChatEvent) => {
      if (e.type === "progress") setPhase(e.message);
      else if (e.type === "quick") {
        // Featured-snippet answer — arrives instantly, before the streamed prose.
        setQuick(e.quickAnswer);
      } else if (e.type === "meta") {
        // Cards + intent arrive first; render them and clear any prior prose so
        // the incoming deltas stream into a fresh answer.
        setProducts(e.products);
        setJsonld(e.jsonld ?? null);
        setAnswer("");
      } else if (e.type === "delta") {
        // Append each token — functional update keeps rapid deltas correct.
        setAnswer((prev) => prev + e.text);
      } else if (e.type === "web") {
        setWeb(e.webInsights);
      } else if (e.type === "error") setError(e.message);
      else if (e.type === "done") {
        setPhase(null);
        setLoading(false);
      }
    });
    setLoading(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onAsk();
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-slate-50 text-slate-900">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:py-14">
        {/* Header */}
        <header className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-200">
            <ShoppingBag className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              E-Commerce Search Engine
            </h1>
            <p className="text-sm text-slate-500">
              Grounded answers with{" "}
              <span className="font-semibold text-slate-700">live price &amp; stock</span>, real
              reviews and specifications
            </p>
          </div>
        </header>

        {/* Input */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <Link2 className="h-3.5 w-3.5" /> Website URL
          </label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.example.com"
            className="mt-1.5 w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />

          <label className="mt-5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <MessageSquareText className="h-3.5 w-3.5" /> Prompt
          </label>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder="e.g. A comfortable office chair under $150 that's in stock — what do you recommend?"
            className="mt-1.5 w-full resize-none rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />

          <button
            onClick={onAsk}
            disabled={loading || !query.trim()}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-3 font-semibold text-white shadow-lg shadow-indigo-200 transition hover:from-indigo-700 hover:to-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
              </>
            ) : (
              <>
                <Search className="h-4 w-4" /> Ask the engine
              </>
            )}
          </button>

          {phase && (
            <p className="mt-3 flex items-center gap-2 text-sm text-indigo-600">
              <Loader2 className="h-4 w-4 animate-spin" /> {phase}
            </p>
          )}
        </section>

        {/* Error */}
        {error && (
          <div className="mt-6 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Quick answer — precomputed AEO snippet, shown instantly */}
        {quick && (
          <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/70 p-5">
            <h2 className="mb-1 flex flex-wrap items-center gap-2 text-sm font-bold uppercase tracking-wide text-amber-700">
              <Zap className="h-4 w-4" /> Quick answer
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-amber-700">
                precomputed from this catalog
              </span>
            </h2>
            <p className="text-xs font-medium text-amber-800/80">{quick.question}</p>
            <p className="mt-1 text-[15px] leading-relaxed text-slate-700">{quick.answer}</p>
            <a
              href={quick.url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-700 hover:text-amber-800"
            >
              {quick.title} <ExternalLink className="h-3 w-3" />
            </a>
          </section>
        )}

        {/* Answer */}
        {answer && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-indigo-600">
              <Sparkles className="h-4 w-4" /> Grounded answer
            </h2>
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700">
              {renderRich(answer)}
              {loading && (
                <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-indigo-500 align-text-bottom" />
              )}
            </p>
          </section>
        )}

        {/* Web insights — external opinions, kept separate from grounded facts */}
        {web && web.text && (
          <section className="mt-6 rounded-2xl border border-sky-200 bg-sky-50/60 p-6">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-sky-700">
              <Globe className="h-4 w-4" /> What the web says
              <span className="ml-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-sky-600">
                external opinions · not the store's live data
              </span>
            </h2>
            <ul className="space-y-1.5">
              {web.text
                .split("\n")
                // The model returns one insight per line as "- …"; strip the
                // leading bullet marker so we can render our own styled bullets.
                .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
                .filter(Boolean)
                .map((point, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[15px] leading-relaxed text-slate-700"
                  >
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                    <span>{renderRich(point)}</span>
                  </li>
                ))}
            </ul>
            {web.sources.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {web.sources.map((s, i) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-[220px] items-center gap-1 truncate rounded-lg border border-sky-200 bg-white px-2.5 py-1 text-xs text-sky-700 hover:bg-sky-100"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    <span className="truncate">{s.title}</span>
                  </a>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Product cards */}
        {products.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-600">
              <ShoppingBag className="h-4 w-4" /> Products &amp; suggestions
            </h2>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {products.map((p) => (
                <Card key={p.id} p={p} />
              ))}
            </div>
          </section>
        )}

        {/* Exportable schema.org structured data for the anchor product */}
        {jsonld != null && <JsonLdPanel data={jsonld} />}
      </div>
    </div>
  );
}
