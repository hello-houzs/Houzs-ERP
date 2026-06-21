// ----------------------------------------------------------------------------
// localities — MY State→City→Postcode reference (my_localities).
// Ported from 2990's apps/api/src/routes/localities.ts (POST/PATCH/DELETE),
// PLUS a GET list added for Houzs.
//
// Commander 2026-05-27: "也需要进行维护: State, City, Postcode".
//
// GET /localities      — list all my_localities rows (state→city→postcode
//                        cascade source for SupplierDetail + SO delivery cards).
// POST /localities     — create a row.
// PATCH /localities/:id — update a row (incl. city-level warehouse override).
// DELETE /localities/:id — drop a row.
//
// HOUZS VENDOR: in 2990's the READ is done client-side via a direct supabase
// select (localities-queries.ts). Houzs has no client-side supabase, so the
// vendored useLocalities hook routes through this GET. scm.my_localities EXISTS
// (cols id/postcode/city/state/state_code/country/warehouse_id, verified
// 2026-06-20) but ships EMPTY — the full MY postcode dataset is a large seed
// flagged as a SEPARATE task. Until seeded this returns [], and the frontend
// StateSelect falls back to a free-text State input (the verbatim no-data
// behaviour the source already handles).
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { z } from "zod";
import { supabaseAuth } from "../middleware/auth";
import type { Env, Variables } from "../env";

export const localities = new Hono<{ Bindings: Env; Variables: Variables }>();

localities.use("*", supabaseAuth);

// GET / — list all rows (the state→city→postcode cascade source). Degrades to
// [] when the table is missing or empty.
localities.get("/", async (c) => {
  const sb = c.get("supabase");
  // PostgREST caps a single response at max-rows (1000), so `.limit(20000)` was
  // silently truncating the 2,933-row MY dataset to the first 1000 (≈7 states).
  // Page through with .range() (each request ≤1000) and concatenate the lot.
  const PAGE = 1000;
  const data: Record<string, unknown>[] = [];
  for (let from = 0; from <= 50000; from += PAGE) {
    const { data: chunk, error } = await sb
      .from("my_localities")
      .select("id, postcode, city, state, state_code, country, warehouse_id")
      .order("state", { ascending: true })
      .order("city", { ascending: true })
      .order("postcode", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (/relation .* does not exist/i.test(error.message)) return c.json({ localities: [] });
      return c.json({ error: "load_failed", reason: error.message }, 500);
    }
    const rows = (chunk ?? []) as Record<string, unknown>[];
    data.push(...rows);
    if (rows.length < PAGE) break; // last page
  }
  // Dual-read camelCase ?? snake_case — cover the PostgREST casing either way.
  const localitiesRows = data.map((r: Record<string, unknown>) => ({
    id: r.id,
    postcode: r.postcode,
    city: r.city,
    state: r.state,
    stateCode: r.stateCode ?? r.state_code ?? "",
    country: r.country ?? "Malaysia",
    warehouseId: r.warehouseId ?? r.warehouse_id ?? null,
  }));
  return c.json({ localities: localitiesRows });
});

const createSchema = z.object({
  state: z.string().trim().min(1),
  stateCode: z.string().trim().min(1),
  city: z.string().trim().min(1),
  postcode: z.string().trim().min(1),
  /* Task #121 — optional, defaults to Malaysia. */
  country: z.string().trim().min(1).optional(),
});

const updateSchema = z.object({
  state: z.string().trim().min(1).optional(),
  stateCode: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  postcode: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
  /* Commander 2026-05-27 — city-level warehouse override.
     '' or null explicitly clears the override (falls back to state-level). */
  warehouseId: z.union([z.string().uuid(), z.literal(""), z.null()]).optional(),
});

// POST / — create a new row.
localities.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const sb = c.get("supabase");
  const { data, error } = await sb
    .from("my_localities")
    .insert({
      state: parsed.data.state,
      state_code: parsed.data.stateCode.toUpperCase(),
      city: parsed.data.city,
      postcode: parsed.data.postcode,
      country: parsed.data.country ?? "Malaysia",
    })
    .select("id, state, state_code, city, postcode, country")
    .single();
  if (error) return c.json({ error: "insert_failed", reason: error.message }, 500);
  return c.json({ locality: data });
});

// PATCH /:id — update a row.
localities.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const patch: Record<string, string | null> = {};
  if (parsed.data.state) patch.state = parsed.data.state;
  if (parsed.data.stateCode) patch.state_code = parsed.data.stateCode.toUpperCase();
  if (parsed.data.city) patch.city = parsed.data.city;
  if (parsed.data.postcode) patch.postcode = parsed.data.postcode;
  if (parsed.data.country) patch.country = parsed.data.country;
  /* warehouseId: empty string or null clears the override; uuid sets it. */
  if (parsed.data.warehouseId !== undefined) {
    patch.warehouse_id =
      parsed.data.warehouseId === "" || parsed.data.warehouseId === null
        ? null
        : parsed.data.warehouseId;
  }
  if (Object.keys(patch).length === 0) return c.json({ ok: true, changed: 0 });

  const sb = c.get("supabase");
  const { data, error } = await sb
    .from("my_localities")
    .update(patch)
    .eq("id", id)
    .select("id, state, state_code, city, postcode, country, warehouse_id")
    .maybeSingle();
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json({ locality: data });
});

// DELETE /:id — drop a row.
localities.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const sb = c.get("supabase");
  const { error } = await sb.from("my_localities").delete().eq("id", id);
  if (error) return c.json({ error: "delete_failed", reason: error.message }, 500);
  return c.json({ ok: true });
});

export default localities;
