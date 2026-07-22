import { Hono } from "hono";
import type { Env } from "../types";
import { getSupabaseService, isSupabaseConfigured } from "../db/supabase";
import { escapeForOr } from "../scm/lib/postgrest-search";
import {
  activeCompanySql,
  allowedCompaniesSql,
  houzsCompanySql,
  scopeToCompany,
  type CompanyScopeCtx,
} from "../scm/lib/companyScope";
import { isDirectorUser, isSalesUser } from "../services/pmsAccess";

/**
 * Global search across the workspace.
 *
 *   GET /api/search?q=<term>
 *
 * Returns up to N matches per source, grouped by type. Designed for
 * the frontend Cmd+K palette (desktop) AND the mobile search palette —
 * the result shape stays uniform so both UIs can render a flat list
 * with type chips and bold the matched keyword.
 *
 * Sources:
 *   - project      (public.projects)              — env.DB
 *   - assr_case    (public.assr_cases)            — env.DB
 *   - user         (public.users)                 — env.DB
 *   - sales_order  (scm.mfg_sales_orders)         — Supabase (scm schema)
 *   - product      (scm.mfg_products)             — Supabase (scm schema)
 *
 * The public-schema sources use LIKE (rewritten to ILIKE + Postgres `$n`
 * by the d1-compat shim). The scm-schema sources talk to the SAME
 * Supabase over PostgREST via getSupabaseService (db.schema='scm').
 *
 * SCM sources are wrapped in a guarded helper: if the Supabase keys are
 * unset (tests / local) or PostgREST hiccups, we return the public-schema
 * hits we DO have rather than 500-ing the whole search. Existing search
 * behaviour is therefore never broken by the SCM additions.
 *
 * Auth: gated by the global /api/* auth middleware (mounted in
 * src/index.ts). COMPANY scoping IS enforced per source (see the scoping block
 * in the handler) — that is the multi-company isolation boundary. ROW-LEVEL
 * PERMISSION scoping (PIC / brand / salesperson visibility) is intentionally
 * loose: search shows match metadata only (no full record contents), and
 * follow-up navigation hits the relevant module, which enforces its own perms.
 */

const app = new Hono<{ Bindings: Env }>();

const PER_SOURCE_LIMIT = 6;

interface Hit {
  type: "project" | "assr_case" | "user" | "sales_order" | "product";
  id: string | number;       // primary key for deep-link
  title: string;             // headline
  subtitle?: string | null;  // contextual line
  date?: string | null;      // optional anchor date (DD/MM/YYYY on the client)
  link: string;              // SPA destination (with focus= when relevant)
}

export function searchPattern(raw: string, postgrest = false): string | null {
  // `%` and `_` are SQL LIKE wildcards; PostgREST also accepts `*` as an
  // alias for `%`. Neutralise all three before either query grammar sees them.
  const grammarSafe = postgrest ? escapeForOr(raw) : raw;
  const term = grammarSafe.replace(/[%_*]/g, "").trim();
  if (!term) return null;
  // A one-character contains scan cannot use pg_trgm at ERP scale. Make the
  // first key a real whole-database prefix search; from the second key onward
  // the existing trigram-backed contains search takes over.
  return [...term].length === 1 ? `${term}%` : `%${term}%`;
}

// ASSR company pin — MUST stay in sync with routes/assr.ts assrCompanySql().
// Service Cases are a HOUZS-only module: rank-and-file Sales are PINNED to
// HOUZS (never see 2990 cases), while office / backend / directors run one
// cross-company portal and widen to their allowed set. Returns the same
// three-state fragment as its primitives — "" when the company context is
// unresolved (legacy single-company), a match-nothing predicate when the
// caller is resolved but restricted, never fail open.
function assrCompanySql(c: CompanyScopeCtx): string {
  const user = c.get("user") as Parameters<typeof isSalesUser>[0];
  const pinsToHouzs = isSalesUser(user) && !isDirectorUser(user);
  return pinsToHouzs ? houzsCompanySql(c) : allowedCompaniesSql(c);
}

app.get("/", async (c) => {
  const raw = (c.req.query("q") || "").trim();
  const pat = searchPattern(raw);
  if (!pat) {
    return c.json({ q: raw, hits: [] as Hit[] });
  }

  const env = c.env;
  const hits: Hit[] = [];

  // Multi-company scoping. Each fragment is "" ONLY when the company context is
  // unresolved (pre-migration / D1 test mirror / cold-start), so legacy
  // single-company SQL runs unchanged; a RESOLVED-but-restricted caller gets a
  // match-nothing predicate instead — never fail open, because the DB client is
  // service-role (RLS bypassed) so these predicates ARE the isolation boundary:
  //   · projects follow the ACTIVE company (per-company module, like the
  //     Projects page itself) via activeCompanySql;
  //   · ASSR is HOUZS-only: rank-and-file Sales are PINNED to HOUZS, office /
  //     backend / directors widen to their allowed set — the exact rule the
  //     /api/assr list uses (assrCompanySql, mirrored above);
  //   · users stay global — matches /api/users, an unscoped shared directory.
  const projectCoSql = activeCompanySql(c);
  const assrCoSql = assrCompanySql(c);

  // ── Public-schema sources (env.DB) ─────────────────────────
  // Fire all source queries in parallel — they share a Postgres client
  // anyway, so this just avoids serial round-trip latency.
  const [projectRows, assrRows, userRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, code, name, stage, start_date
         FROM projects
        WHERE archived_at IS NULL
          AND (code LIKE ?1 OR name LIKE ?1 OR venue LIKE ?1 OR organizer LIKE ?1
               OR brand LIKE ?1)${projectCoSql}
        ORDER BY start_date DESC NULLS LAST, id DESC
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(pat)
      .all<{
        id: number;
        code: string;
        name: string;
        stage: string | null;
        start_date: string | null;
      }>(),

    env.DB.prepare(
      `SELECT id, assr_no, customer_name, complaint_issue, status, complained_date
         FROM assr_cases
        WHERE archived_at IS NULL
          AND (assr_no LIKE ?1 OR customer_name LIKE ?1 OR phone LIKE ?1
               OR complaint_issue LIKE ?1 OR doc_no LIKE ?1 OR po_no LIKE ?1)${assrCoSql}
        ORDER BY complained_date DESC NULLS LAST, id DESC
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(pat)
      .all<{
        id: number;
        assr_no: string;
        customer_name: string | null;
        complaint_issue: string | null;
        status: string;
        complained_date: string | null;
      }>(),

    // role_id joins to roles table for the human-readable name; left
    // join is fine because the user list is short.
    env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.user_type, r.name AS role_name
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE COALESCE(u.status, 'active') != 'disabled'
          AND (u.name LIKE ?1 OR u.email LIKE ?1 OR r.name LIKE ?1)
        ORDER BY u.name ASC
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(pat)
      .all<{
        id: number;
        name: string;
        email: string;
        user_type: string | null;
        role_name: string | null;
      }>(),
  ]);

  // Projects — start_date anchors the hit's date and drives the calendar jump.
  for (const r of projectRows.results ?? []) {
    const code = pick(r, "code");
    const name = pick(r, "name");
    hits.push({
      type: "project",
      id: r.id,
      title: [code, name].filter(Boolean).join(" · ") || name || String(r.id),
      subtitle: pick(r, "stage"),
      date: pick(r, "start_date"),
      link: `/projects?focus=${r.id}`,
    });
  }

  for (const r of assrRows.results ?? []) {
    hits.push({
      type: "assr_case",
      id: r.id,
      title: pick(r, "assr_no") ?? String(r.id),
      subtitle:
        [pick(r, "customer_name"), pick(r, "complaint_issue")].filter(Boolean).join(" · ") ||
        pick(r, "status"),
      date: pick(r, "complained_date"),
      link: `/assr?focus=${r.id}`,
    });
  }

  for (const r of userRows.results ?? []) {
    hits.push({
      type: "user",
      id: r.id,
      title: pick(r, "name") ?? str(r.email) ?? String(r.id),
      subtitle: [pick(r, "role_name"), pick(r, "email")].filter(Boolean).join(" · "),
      link: `/team?focus=${r.id}`,
    });
  }

  // ── SCM sources (Supabase, scm schema) ─────────────────────
  // Guarded: any failure here degrades gracefully to the public hits above.
  await appendScmHits(c, env, raw, hits);

  return c.json({ q: raw, hits });
});

/**
 * Append Sales Order + Product hits from the scm schema. Never throws — a
 * missing Supabase config or a PostgREST error just yields zero SCM hits so
 * the public-schema search still returns. The `.or(...)` free-text is passed
 * through escapeForOr() so a term with PostgREST grammar chars (`,(){}`) can't
 * corrupt the filter.
 */
async function appendScmHits(
  c: CompanyScopeCtx,
  env: Env,
  raw: string,
  hits: Hit[],
): Promise<void> {
  if (!isSupabaseConfigured(env)) return;
  const wildcard = searchPattern(raw, true);
  if (!wildcard) return;

  let sb: ReturnType<typeof getSupabaseService>;
  try {
    sb = getSupabaseService(env);
  } catch {
    return;
  }

  // Multi-company: SOs + products are PER-COMPANY modules, so their search hits
  // follow the ACTIVE company via scopeToCompany — the same helper the SO /
  // product list routes use. Unresolved → no predicate (legacy single-company);
  // resolved-but-restricted → an empty `in` that matches nothing (never fail
  // open).
  const soQuery = sb
    .from("mfg_sales_orders")
    .select("doc_no, debtor_name, phone, ref, so_date, branding")
    .or(
      `doc_no.ilike.${wildcard},debtor_name.ilike.${wildcard},` +
        `ref.ilike.${wildcard},phone.ilike.${wildcard},po_doc_no.ilike.${wildcard}`
    );
  const prodQuery = sb
    .from("mfg_products")
    .select("id, code, name, description, sell_price_sen")
    .eq("status", "ACTIVE")
    .or(`code.ilike.${wildcard},name.ilike.${wildcard},description.ilike.${wildcard}`);

  const [soRes, prodRes] = await Promise.allSettled([
    scopeToCompany(soQuery, c)
      .order("so_date", { ascending: false })
      .limit(PER_SOURCE_LIMIT),
    scopeToCompany(prodQuery, c)
      .order("code", { ascending: true })
      .limit(PER_SOURCE_LIMIT),
  ]);

  if (soRes.status === "fulfilled" && !soRes.value.error) {
    for (const r of (soRes.value.data ?? []) as Array<Record<string, unknown>>) {
      const docNo = String(r.doc_no ?? "");
      if (!docNo) continue;
      hits.push({
        type: "sales_order",
        id: docNo,
        title: docNo,
        subtitle:
          [str(r.debtor_name), str(r.branding), str(r.ref)].filter(Boolean).join(" · ") ||
          str(r.phone),
        date: str(r.so_date),
        // Deep-link the SPA straight to the SO detail route
        // (/scm/sales-orders/:docNo); the mobile palette maps the same doc_no
        // onto its own so-detail screen.
        link: `/scm/sales-orders/${encodeURIComponent(docNo)}`,
      });
    }
  }

  if (prodRes.status === "fulfilled" && !prodRes.value.error) {
    for (const r of (prodRes.value.data ?? []) as Array<Record<string, unknown>>) {
      const code = str(r.code);
      if (!code) continue;
      hits.push({
        type: "product",
        id: code,
        title: [code, str(r.name)].filter(Boolean).join(" · ") || code,
        subtitle: str(r.description),
        date: null,
        link: `/scm/products?focus=${encodeURIComponent(code)}`,
      });
    }
  }
}

// pg driver camelCases result columns; dual-read camelCase ?? snake_case so a
// column surfaces whichever way the row arrives (project #1 recurring bug).
function pick<T extends Record<string, unknown>>(row: T, snake: string): string | null {
  const camel = snake.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
  const v = (row as Record<string, unknown>)[camel] ?? (row as Record<string, unknown>)[snake];
  return v == null ? null : String(v);
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

export default app;
