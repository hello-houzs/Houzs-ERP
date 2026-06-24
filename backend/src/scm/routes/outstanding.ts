// ----------------------------------------------------------------------------
// /outstanding — Unified Outstanding filter API across all doc modules.
// Ported from 2990's apps/api/src/routes/outstanding.ts.
//
// Commander 2026-05-26: "全部都要能 filter 出来 Outstanding 跟非 Outstanding
// 的部分. by date".
//
// Backed by scm.v_*_outstanding views. Each module has its own definition of
// "outstanding". Endpoints:
//   GET /outstanding/po              — POs not fully received
//   GET /outstanding/grn             — GRNs not yet billed
//   GET /outstanding/pi              — PIs not fully paid
//   GET /outstanding/pr              — PRs not yet completed
//   GET /outstanding/so              — SOs not yet delivered/invoiced/closed
//   GET /outstanding/do              — DOs not yet invoiced
//   GET /outstanding/si              — SIs not fully paid
//   GET /outstanding/summary         — counts + totals across all modules
//
// All endpoints accept query params:
//   ?outstanding=true|false|all   (default: true — only outstanding rows)
//   ?from=YYYY-MM-DD              (filter by doc date >= from)
//   ?to=YYYY-MM-DD               (filter by doc date <= to)
//
// HOUZS VENDOR: the v_*_outstanding views exist in the scm schema (verified
// 2026-06-20). They DEGRADE GRACEFULLY — when no docs exist the view simply
// returns 0 rows (the route returns { rows: [] } / a zeroed summary), so the
// Outstanding page never 500s on an empty DB.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import type { Env, Variables } from "../env";
import { paginateAll } from "../lib/paginate-all";

export const outstanding = new Hono<{ Bindings: Env; Variables: Variables }>();
outstanding.use("*", supabaseAuth);

// Map endpoint → (view, date column for from/to filter).
const MODULES: Record<string, { view: string; dateCol: string }> = {
  po:  { view: "v_po_outstanding",  dateCol: "po_date" },
  grn: { view: "v_grn_outstanding", dateCol: "received_at" },
  pi:  { view: "v_pi_outstanding",  dateCol: "invoice_date" },
  pr:  { view: "v_pr_outstanding",  dateCol: "return_date" },
  so:  { view: "v_so_outstanding",  dateCol: "so_date" },
  do:  { view: "v_do_outstanding",  dateCol: "do_date" },
  si:  { view: "v_si_outstanding",  dateCol: "invoice_date" },
};

for (const [slug, { view, dateCol }] of Object.entries(MODULES)) {
  outstanding.get(`/${slug}`, async (c) => {
    const sb = c.get("supabase");
    const outstandingParam = c.req.query("outstanding");
    const from = c.req.query("from");
    const to = c.req.query("to");

    // Page through so PostgREST's 1000-row cap can't silently truncate the
    // outstanding list (an "all"/wide-range view can exceed 1000 docs).
    const { data, error } = await paginateAll((pFrom, pTo) => {
      let q = sb.from(view).select("*").order(dateCol, { ascending: false });
      // outstanding filter: default = true (only outstanding rows)
      if (outstandingParam === "true" || outstandingParam == null) {
        q = q.eq("is_outstanding", true);
      } else if (outstandingParam === "false") {
        q = q.eq("is_outstanding", false);
      }
      // else 'all' (or any other value) → no filter, return both
      /* LEAK GUARD (DRAFT) — a DRAFT Sales Invoice has not posted AR yet, so it
         must never appear in the SI Outstanding / AR-aging list. The
         v_si_outstanding view's is_outstanding CASE only excludes PAID/CANCELLED
         (it would mark a DRAFT outstanding), so filter DRAFT out here. The view
         exposes s.status, so this is safe (verified 0059_outstanding_views.sql). */
      if (slug === "si") q = q.neq("status", "DRAFT");
      if (from) q = q.gte(dateCol, from);
      if (to) q = q.lte(dateCol, to);
      return q.range(pFrom, pTo);
    });
    if (error) {
      // The view is missing entirely → treat as "no data yet" so the page
      // renders an empty tab instead of 500ing.
      if (/relation .* does not exist/i.test(error.message)) {
        return c.json({ rows: [] });
      }
      return c.json({ error: "load_failed", reason: error.message }, 500);
    }
    return c.json({ rows: data ?? [] });
  });
}

/* /outstanding/summary — counts + totals across all modules in one call.
   Used by the cross-module Outstanding Dashboard. Degrades to a zeroed summary
   when a view is missing/empty. */
outstanding.get("/summary", async (c) => {
  const sb = c.get("supabase");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const summary: Record<
    string,
    { count: number; total_centi?: number; total_outstanding_centi?: number }
  > = {};
  for (const [slug, { view, dateCol }] of Object.entries(MODULES)) {
    // Page through — the count + totals reduce over EVERY row, so PostgREST's
    // 1000-row cap would understate both on a large outstanding set.
    const { data } = await paginateAll((pFrom, pTo) => {
      let q = sb.from(view).select("*").eq("is_outstanding", true);
      // LEAK GUARD (DRAFT) — keep DRAFT SIs out of the AR outstanding totals.
      if (slug === "si") q = q.neq("status", "DRAFT");
      if (from) q = q.gte(dateCol, from);
      if (to) q = q.lte(dateCol, to);
      return q.range(pFrom, pTo);
    });
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    summary[slug] = {
      count: rows.length,
      total_centi: rows.reduce(
        (s, r) => s + Number(r.total_centi ?? r.local_total_centi ?? 0),
        0,
      ),
      total_outstanding_centi: rows.reduce(
        (s, r) => s + Number(r.outstanding_centi ?? 0),
        0,
      ),
    };
  }
  return c.json({ summary });
});

export default outstanding;
