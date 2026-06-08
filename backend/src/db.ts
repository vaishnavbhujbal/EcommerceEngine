// db.ts — the single Postgres connection for the whole backend.
//
// Everything that touches the database (health check, ingest, retrieval, RAG)
// imports `pool` from here. Centralizing it means one place to configure SSL,
// pool size, and the connection string.

import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // Fail loud and early — a missing DB URL would otherwise surface as a
  // confusing runtime error on the first query.
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// Supabase requires TLS. node-pg does not reliably honor `sslmode=require` from
// the URL, so we set SSL explicitly. We only enable it for Supabase hosts so a
// future plain local Postgres still connects without SSL.
//
// Trade-off: `rejectUnauthorized: false` encrypts the connection but skips CA
// verification (no cert bundling needed for the POC). For production you would
// pin Supabase's CA certificate instead.
const isSupabase = connectionString.includes("supabase");

export const pool = new Pool({
  connectionString,
  ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
});

// Convenience re-export so callers can run a one-off query without manually
// checking out a client. The pool handles checkout/return per call.
export const query = pool.query.bind(pool);
