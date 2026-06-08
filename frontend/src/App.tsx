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
} from "lucide-react";
import { postChat, type ChatEvent, type ProductCard, type WebInsights } from "./api";

const SAMPLE_URL = "https://www.ikea.com/";

function formatPrice(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  const sym = !currency || currency === "USD" ? "$" : `${currency} `;
  return `${sym}${(cents / 100).toFixed(2)}`;
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

export default function App() {
  const [url, setUrl] = useState(SAMPLE_URL);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string>("");
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [web, setWeb] = useState<WebInsights | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onAsk() {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    setAnswer("");
    setProducts([]);
    setWeb(null);
    setPhase("Starting…");

    await postChat({ query: query.trim(), url: url.trim() || undefined }, (e: ChatEvent) => {
      if (e.type === "progress") setPhase(e.message);
      else if (e.type === "result") {
        setAnswer(e.answer);
        setProducts(e.products);
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
        <header className="mb-8 flex items-center gap-3">
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
              reviews and specs — beat ChatGPT &amp; Perplexity on the same prompt + URL.
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

        {/* Answer */}
        {answer && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-indigo-600">
              <Sparkles className="h-4 w-4" /> Grounded answer
            </h2>
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700">
              {answer}
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
            <p className="text-[15px] leading-relaxed text-slate-700">{web.text}</p>
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
      </div>
    </div>
  );
}
