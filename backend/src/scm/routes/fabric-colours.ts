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
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import type { Env, Variables } from "../env";

export const fabricColours = new Hono<{ Bindings: Env; Variables: Variables }>();

fabricColours.use("*", supabaseAuth);

// GET / — active colour rows ordered by sort_order (mirrors 2990's
// useFabricColoursActive: .eq('active', true).order('sort_order')).
fabricColours.get("/", async (c) => {
  const supabase = c.get("supabase");
  const { data, error } = await supabase
    .from("fabric_colours")
    .select("fabric_id, colour_id, label, swatch_hex, active, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true });
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
    sortOrder: r.sortOrder ?? r.sort_order ?? 0,
  }));
  return c.json({ colours });
});

export default fabricColours;
