import { Hono } from "hono";
import type { Env } from "../types";

/**
 * Global search across the workspace.
 *
 *   GET /api/search?q=<term>
 *
 * Returns up to N matches per source, grouped by type. Designed for
 * the frontend Cmd+K palette — the result shape stays uniform so the
 * UI can render a flat list with type chips.
 *
 * Each query uses LIKE so SQLite's lack of FTS isn't blocking. The
 * query patterns are constructed safely (each LIKE param is bound),
 * so the only thing user-controlled is the value, not the SQL.
 *
 * Auth: gated by the global /api/* auth middleware (mounted in
 * src/index.ts). Permission scoping is intentionally loose — search
 * shows match metadata only (no full record contents), and follow-up
 * navigation hits the relevant module which enforces its own perms.
 */

const app = new Hono<{ Bindings: Env }>();

const PER_SOURCE_LIMIT = 6;

interface Hit {
  type:
    | "sales_order"
    | "purchase_order"
    | "purchase_order_doc"
    | "project"
    | "assr_case"
    | "creditor"
    | "trip"
    | "user";
  id: string | number;       // primary key for deep-link
  title: string;             // headline
  subtitle?: string | null;  // contextual line
  date?: string | null;      // optional anchor date
  link: string;              // SPA destination (with focus= when relevant)
}

function like(q: string): string {
  // Escape SQL LIKE wildcards in user input so a stray `%` doesn't
  // turn the query into a list-everything. We don't ESCAPE in the
  // statement (kept simple) — just neutralise the wildcards.
  return `%${q.replace(/[%_]/g, "")}%`;
}

app.get("/", async (c) => {
  const raw = (c.req.query("q") || "").trim();
  if (raw.length < 2) {
    return c.json({ q: raw, hits: [] as Hit[] });
  }
  const pat = like(raw);

  const env = c.env;
  const hits: Hit[] = [];

  // Fire all source queries in parallel — they share a SQLite worker
  // anyway, so this just avoids serial round-trip latency.
  const [
    salesRows,
    poLineRows,
    poDocRows,
    projectRows,
    assrRows,
    creditorRows,
    tripRows,
    userRows,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT id, doc_no, debtor_name, doc_date
         FROM sales_orders
        WHERE doc_no LIKE ?1
           OR debtor_name LIKE ?1
           OR ref LIKE ?1
        ORDER BY doc_date DESC NULLS LAST, id DESC
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(pat)
      .all<{ id: number; doc_no: string; debtor_name: string | null; doc_date: string | null }>(),

    env.DB.prepare(
      `SELECT id, doc_no, item_code, item_description, creditor_name, doc_date
         FROM purchase_orders
        WHERE doc_no LIKE ?1
           OR item_code LIKE ?1
           OR item_description LIKE ?1
           OR creditor_name LIKE ?1
        ORDER BY doc_date DESC NULLS LAST, id DESC
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(pat)
      .all<{
        id: number;
        doc_no: string;
        item_code: string;
        item_description: string | null;
        creditor_name: string | null;
        doc_date: string | null;
      }>(),

    env.DB.prepare(
      `SELECT doc_no, ref, creditor_name, doc_date
         FROM purchase_order_docs
        WHERE doc_no LIKE ?1
           OR ref LIKE ?1
           OR creditor_name LIKE ?1
        ORDER BY doc_date DESC NULLS LAST
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(pat)
      .all<{
        doc_no: string;
        ref: string | null;
        creditor_name: string | null;
        doc_date: string | null;
      }>(),

    env.DB.prepare(
      `SELECT id, code, name, stage, start_date
         FROM projects
        WHERE archived_at IS NULL
          AND (code LIKE ?1 OR name LIKE ?1 OR venue LIKE ?1 OR organizer LIKE ?1)
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
               OR complaint_issue LIKE ?1 OR doc_no LIKE ?1 OR po_no LIKE ?1)
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

    env.DB.prepare(
      `SELECT creditor_code, company_name, desc2, email, phone1, currency_code
         FROM creditors
        WHERE creditor_code LIKE ?1
           OR company_name LIKE ?1
           OR desc2 LIKE ?1
           OR email LIKE ?1
           OR phone1 LIKE ?1
           OR mobile LIKE ?1
        ORDER BY company_name ASC
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(pat)
      .all<{
        creditor_code: string;
        company_name: string | null;
        desc2: string | null;
        email: string | null;
        phone1: string | null;
        currency_code: string | null;
      }>(),

    env.DB.prepare(
      `SELECT id, trip_no, status, trip_date
         FROM trips
        WHERE trip_no LIKE ?1 OR notes LIKE ?1
        ORDER BY trip_date DESC NULLS LAST, id DESC
        LIMIT ${PER_SOURCE_LIMIT}`
    )
      .bind(pat)
      .all<{
        id: number;
        trip_no: string;
        status: string;
        trip_date: string | null;
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

  for (const r of salesRows.results ?? []) {
    hits.push({
      type: "sales_order",
      id: r.id,
      title: r.doc_no,
      subtitle: r.debtor_name,
      date: r.doc_date,
      link: `/orders?focus=${r.id}`,
    });
  }

  // Dedup PO line/doc — if a doc_no shows up in both, prefer the doc
  // hit (it's the canonical row in the unified Purchase Orders view).
  const seenPoDoc = new Set<string>();
  for (const r of poDocRows.results ?? []) {
    seenPoDoc.add(r.doc_no);
    hits.push({
      type: "purchase_order_doc",
      id: r.doc_no,
      title: r.doc_no,
      subtitle: [r.creditor_name, r.ref].filter(Boolean).join(" · ") || null,
      date: r.doc_date,
      link: `/po?focus=${encodeURIComponent(r.doc_no)}`,
    });
  }
  for (const r of poLineRows.results ?? []) {
    if (seenPoDoc.has(r.doc_no)) continue;
    hits.push({
      type: "purchase_order",
      id: r.id,
      title: `${r.doc_no} · ${r.item_code}`,
      subtitle: [r.creditor_name, r.item_description].filter(Boolean).join(" · ") || null,
      date: r.doc_date,
      link: `/po?focus=${encodeURIComponent(r.doc_no)}`,
    });
  }

  for (const r of projectRows.results ?? []) {
    hits.push({
      type: "project",
      id: r.id,
      title: `${r.code} · ${r.name}`,
      subtitle: r.stage,
      date: r.start_date,
      link: `/projects?focus=${r.id}`,
    });
  }

  for (const r of assrRows.results ?? []) {
    hits.push({
      type: "assr_case",
      id: r.id,
      title: r.assr_no,
      subtitle: [r.customer_name, r.complaint_issue].filter(Boolean).join(" · ") || r.status,
      date: r.complained_date,
      link: `/assr?focus=${r.id}`,
    });
  }

  for (const r of creditorRows.results ?? []) {
    hits.push({
      type: "creditor",
      id: r.creditor_code,
      title: r.company_name || r.creditor_code,
      subtitle:
        [r.desc2, r.currency_code, r.email || r.phone1]
          .filter(Boolean)
          .join(" · ") || r.creditor_code,
      link: `/po?view=creditors&focus=${encodeURIComponent(r.creditor_code)}`,
    });
  }

  for (const r of tripRows.results ?? []) {
    hits.push({
      type: "trip",
      id: r.id,
      title: r.trip_no,
      subtitle: r.status,
      date: r.trip_date,
      link: `/trips?focus=${r.id}`,
    });
  }

  for (const r of userRows.results ?? []) {
    hits.push({
      type: "user",
      id: r.id,
      title: r.name,
      subtitle: [r.role_name, r.email].filter(Boolean).join(" · "),
      link: `/team?focus=${r.id}`,
    });
  }

  return c.json({ q: raw, hits });
});

export default app;
