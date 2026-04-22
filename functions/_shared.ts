// Shared types + helpers for Cloudflare Pages Functions

export interface Env {
  DB: D1Database;
  // Set via `wrangler pages secret put <NAME>`
  JWT_SECRET: string;            // HMAC key for JWT signing
  RESEND_API_KEY: string;        // Resend.com API key for email sending
  FROM_EMAIL?: string;           // "hello@houzscentury.com" (default if unset)
  APP_URL?: string;              // "https://houzs-erp-sales.pages.dev" (used in emails)
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Uppercase + trim — used for item codes, doc nos, etc. */
export function norm(s: string | null | undefined): string {
  return (s ?? "").toString().trim();
}

// D1 types for TypeScript — Cloudflare Workers runtime declares these globally
// but we declare minimal shape here for ts-check
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
}
export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes: number; last_row_id: number };
}
export interface D1ExecResult {
  count: number;
  duration: number;
}
