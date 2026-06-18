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
 *
 * Sources are limited to the modules that still exist after the
 * strip-to-core cutover: Projects, ASSR cases, and Users.
 */

const app = new Hono<{ Bindings: Env }>();

const PER_SOURCE_LIMIT = 6;

interface Hit {
  type: "project" | "assr_case" | "user";
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
  const [projectRows, assrRows, userRows] = await Promise.all([
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
