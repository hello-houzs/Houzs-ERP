// ----------------------------------------------------------------------------
// fabric-colours — selling-side fabric COLOUR library (scm.fabric_colours).
// Ported READ from 2990's apps/backend/src/lib/fabric-queries.ts
// (useFabricColoursActive), which in 2990's reads `fabric_colours` DIRECTLY via
// the supabase client (the colour vocabulary the POS/SO line editor offers).
// Houzs has no client-side supabase, so the vendored useFabricColoursActive
// routes through this GET.
//
// GET /fabric-colours — list ACTIVE colour rows (the SoLineCard Fabrics dropdown
//                       source). Degrades to [] when the table is missing.
//                       Response camelCased to the FabricColourRow shape the
//                       frontend expects (fabric-queries.ts).
//
//   Scaling (owner #1 pain 2026-07-14): the SoLineCard Fabrics picker used to
//   pull EVERY active colour on every line card. An OPTIONAL `?q=` turns this
//   into a server typeahead — ilike over colour_id + label, capped at `limit`
//   (default 50). WITHOUT `q` the response is UNCHANGED (full ordered list) so
//   the existing full-list callers (mobile SO, scan matching) keep working.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import { scopeToCompany } from "../lib/companyScope";
import { escapeForOr } from "../lib/postgrest-search";
import type { Env, Variables } from "../env";

export const fabricColours = new Hono<{ Bindings: Env; Variables: Variables }>();

fabricColours.use("*", supabaseAuth);

// GET / — active colour rows ordered by sort_order (mirrors 2990's
// useFabricColoursActive: .eq('active', true).order('sort_order')).
// Optional ?q= (typeahead) + ?limit= (cap, only applied when q is present).
fabricColours.get("/", async (c) => {
  const supabase = c.get("supabase");
  const rawQ = (c.req.query("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  let q = supabase
    .from("fabric_colours")
    .select("fabric_id, colour_id, label, swatch_hex, active, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  q = scopeToCompany(q, c); // multi-company: isolate to the active company
  // Typeahead mode — ilike over the code (colour_id) + label, capped. The
  // no-`q` branch stays byte-for-byte the old full-list behaviour.
  if (rawQ) {
    const s = escapeForOr(rawQ);
    if (s) q = q.or(`colour_id.ilike.%${s}%,label.ilike.%${s}%`);
    q = q.limit(limit);
  }
  const { data, error } = await q;
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) return c.json({ colours: [] });
    return c.json({ error: "load_failed", reason: error.message }, 500);
  }
  // Dual-read camelCase ?? snake_case — cover the PostgREST casing either way.
  const colours = (data ?? []).map((r: Record<string, unknown>) => ({
    fabricId: r.fabricId ?? r.fabric_id ?? "",
    colourId: r.colourId ?? r.colour_id ?? "",
    label: r.label ?? null,
    swatchHex: r.swatchHex ?? r.swatch_hex ?? null,
    // POS filters on `active` (FabricColourRow.active); the list is active-only
    // (server .eq('active', true)), so surface it or the POS drops every row and
    // the colour picker renders empty.
    active: (r.active ?? true) as boolean,
    sortOrder: r.sortOrder ?? r.sort_order ?? 0,
  }));
  return c.json({ colours });
});

export default fabricColours;
