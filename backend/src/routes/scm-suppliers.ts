import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { scm_suppliers, scm_supplier_material_bindings } from "../db/schema";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { requirePermission } from "../middleware/auth";

/**
 * Supply Chain — Supplier master + supplier<->material bindings.
 *
 * Ported from the 2990s ERP into Houzs's self-contained `scm_*` namespace —
 * distinct from the AutoCount-synced read-only `creditors` and from the ASSR
 * service `suppliers`. This is the internal purchasing vendor master.
 *
 *   GET    /api/scm-suppliers               list + search/filter/sort/paginate
 *   GET    /api/scm-suppliers/:id           one supplier + its bindings
 *   POST   /api/scm-suppliers               create
 *   PATCH  /api/scm-suppliers/:id           update
 *   DELETE /api/scm-suppliers/:id           delete (cascades bindings)
 *   GET    /api/scm-suppliers/:id/bindings         list bindings
 *   POST   /api/scm-suppliers/:id/bindings         add binding
 *   PATCH  /api/scm-suppliers/bindings/:bindingId  update binding
 *   DELETE /api/scm-suppliers/bindings/:bindingId  delete binding
 *
 * TODO(perm): writes are currently gated only by the global /api/* auth
 * middleware. Add a dedicated scm.write permission once the Supply Chain
 * page-access key is wired into the roles matrix.
 */
const app = new Hono<{ Bindings: Env }>();
// Owner-only until a dedicated scm.* permission exists (mirrors the Sidebar +
// Route guards; closes the API-layer hole — UI hiding alone isn't access control).
app.use("*", requirePermission("*"));

const SUPPLIER_SORT: Record<string, any> = {
  code: scm_suppliers.code,
  name: scm_suppliers.name,
  status: scm_suppliers.status,
  category: scm_suppliers.category,
  rating: scm_suppliers.rating,
};

// Whitelist of writable columns — never spread the raw request body.
const SUPPLIER_FIELDS = [
  "code", "name", "whatsapp_number", "email", "contact_person", "phone",
  "address", "state", "country", "payment_terms", "status", "rating", "notes",
  "supplier_type", "category", "tin_number", "business_reg_no", "postcode",
  "area", "mobile", "fax", "website", "attention", "business_nature",
  "currency", "statement_type", "aging_basis", "credit_limit_sen",
] as const;

const BINDING_FIELDS = [
  "material_kind", "material_code", "material_name", "supplier_sku",
  "unit_price_centi", "currency", "lead_time_days", "payment_terms_override",
  "moq", "price_valid_from", "price_valid_to", "is_main_supplier", "notes",
  "price_matrix",
] as const;

function pick(body: Record<string, unknown>, fields: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

function isUniqueViolation(e: unknown): boolean {
  const m = String((e as { message?: string })?.message || e).toLowerCase();
  return m.includes("unique") || m.includes("duplicate");
}

// ── suppliers ───────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const search = c.req.query("search")?.trim();
  const status = c.req.query("status")?.trim();
  const category = c.req.query("category")?.trim();
  const page = Math.max(parseInt(c.req.query("page") || "1", 10), 1);
  const perPage = Math.min(Math.max(parseInt(c.req.query("per_page") || "50", 10), 1), 200);
  const sortBy = c.req.query("sort_by") || "name";
  const dir = (c.req.query("sort_dir") || "asc").toLowerCase() === "desc" ? desc : asc;

  const conds = [];
  if (search) {
    const s = `%${search}%`;
    conds.push(
      or(
        ilike(scm_suppliers.code, s),
        ilike(scm_suppliers.name, s),
        ilike(scm_suppliers.email, s),
        ilike(scm_suppliers.phone, s),
        ilike(scm_suppliers.contact_person, s),
      ),
    );
  }
  if (status) conds.push(eq(scm_suppliers.status, status));
  if (category) conds.push(eq(scm_suppliers.category, category));
  const where = conds.length ? and(...conds) : undefined;
  const sortCol = SUPPLIER_SORT[sortBy] || scm_suppliers.name;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scm_suppliers)
    .where(where);

  const rows = await db
    .select()
    .from(scm_suppliers)
    .where(where)
    .orderBy(dir(sortCol))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return c.json({ data: rows, page, per_page: perPage, total: count });
});

app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [supplier] = await db
    .select()
    .from(scm_suppliers)
    .where(eq(scm_suppliers.id, id));
  if (!supplier) return c.json({ error: "Supplier not found" }, 404);
  const bindings = await db
    .select()
    .from(scm_supplier_material_bindings)
    .where(eq(scm_supplier_material_bindings.supplier_id, id))
    .orderBy(asc(scm_supplier_material_bindings.material_code));
  return c.json({ supplier, bindings });
});

app.post("/", async (c) => {
  const db = getDb(c.env);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const data = pick(body, SUPPLIER_FIELDS);
  if (!data.code || !String(data.code).trim()) return c.json({ error: "Code is required" }, 400);
  if (!data.name || !String(data.name).trim()) return c.json({ error: "Name is required" }, 400);
  try {
    const [row] = await db.insert(scm_suppliers).values(data as any).returning();
    return c.json({ supplier: row }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: `Supplier code "${data.code}" already exists` }, 409);
    return c.json({ error: (e as Error)?.message || String(e) }, 500);
  }
});

app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const data = pick(body, SUPPLIER_FIELDS);
  data.updated_at = new Date();
  try {
    const [row] = await db
      .update(scm_suppliers)
      .set(data as any)
      .where(eq(scm_suppliers.id, id))
      .returning();
    if (!row) return c.json({ error: "Supplier not found" }, 404);
    return c.json({ supplier: row });
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: `Supplier code "${data.code}" already exists` }, 409);
    return c.json({ error: (e as Error)?.message || String(e) }, 500);
  }
});

app.delete("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [row] = await db
    .delete(scm_suppliers)
    .where(eq(scm_suppliers.id, id))
    .returning();
  if (!row) return c.json({ error: "Supplier not found" }, 404);
  return c.json({ ok: true });
});

// ── supplier_material_bindings ──────────────────────────────────────────
app.get("/:id/bindings", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const rows = await db
    .select()
    .from(scm_supplier_material_bindings)
    .where(eq(scm_supplier_material_bindings.supplier_id, id))
    .orderBy(asc(scm_supplier_material_bindings.material_code));
  return c.json({ data: rows });
});

app.post("/:id/bindings", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const data = pick(body, BINDING_FIELDS);
  if (!data.material_code || !String(data.material_code).trim())
    return c.json({ error: "material_code is required" }, 400);
  if (!data.material_kind) data.material_kind = "mfg_product";
  if (!data.material_name) data.material_name = data.material_code;
  if (!data.supplier_sku) data.supplier_sku = String(data.material_code);
  data.supplier_id = id;
  try {
    // single main supplier per material — demote siblings if this one is main
    if (data.is_main_supplier === true) {
      await db
        .update(scm_supplier_material_bindings)
        .set({ is_main_supplier: false })
        .where(
          and(
            eq(scm_supplier_material_bindings.material_kind, String(data.material_kind)),
            eq(scm_supplier_material_bindings.material_code, String(data.material_code)),
          ),
        );
    }
    const [row] = await db.insert(scm_supplier_material_bindings).values(data as any).returning();
    return c.json({ binding: row }, 201);
  } catch (e) {
    return c.json({ error: (e as Error)?.message || String(e) }, 500);
  }
});

app.patch("/bindings/:bindingId", async (c) => {
  const db = getDb(c.env);
  const bindingId = c.req.param("bindingId");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const data = pick(body, BINDING_FIELDS);
  data.updated_at = new Date();
  const [row] = await db
    .update(scm_supplier_material_bindings)
    .set(data as any)
    .where(eq(scm_supplier_material_bindings.id, bindingId))
    .returning();
  if (!row) return c.json({ error: "Binding not found" }, 404);
  return c.json({ binding: row });
});

app.delete("/bindings/:bindingId", async (c) => {
  const db = getDb(c.env);
  const bindingId = c.req.param("bindingId");
  const [row] = await db
    .delete(scm_supplier_material_bindings)
    .where(eq(scm_supplier_material_bindings.id, bindingId))
    .returning();
  if (!row) return c.json({ error: "Binding not found" }, 404);
  return c.json({ ok: true });
});

export default app;
