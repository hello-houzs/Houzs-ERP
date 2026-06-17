import { Hono } from "hono";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  scm_purchase_invoices,
  scm_purchase_invoice_items,
  scm_purchase_orders,
  scm_suppliers,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  purchaseInvoiceCreateSchema,
  purchaseInvoiceUpdateSchema,
} from "@shared/billing";

/**
 * Supply Chain — Purchase Invoices (supplier billing). A finance record of what
 * a supplier billed us. NO stock impact: stock arrives via a Goods Receipt
 * (GRN); a PI may exist with or without a matching GRN (PI-without-GRN is
 * intentional). status is driven by amount_paid_centi vs total_centi.
 *
 *   GET    /api/scm-purchase-invoices       list + search/status/paginate
 *   GET    /api/scm-purchase-invoices/:id   header + supplier + PO + items
 *   POST   /api/scm-purchase-invoices       create (header + items[]) status UNPAID
 *   PATCH  /api/scm-purchase-invoices/:id   edit header / record payment / status
 *   DELETE /api/scm-purchase-invoices/:id   delete (cascades items)
 *
 * Owner-only for now (requirePermission "*"), matching the Sidebar/Route guard.
 * Swap to a dedicated scm.* permission when the module is rolled out.
 */
const app = new Hono<{ Bindings: Env }>();
app.use("*", requirePermission("*"));

type Db = ReturnType<typeof getDb>;

function lineTotal(qty: number, unit: number, disc: number): number {
  return Math.max(0, (qty || 0) * (unit || 0) - (disc || 0));
}

// Derive the payment status from paid vs total. CANCELLED is terminal and never
// recomputed away here (callers set/clear it explicitly).
function paymentStatus(paid: number, total: number): "UNPAID" | "PARTIAL" | "PAID" {
  if (paid >= total && total > 0) return "PAID";
  if (paid >= total && total === 0) return "PAID"; // a zero-total invoice is settled
  if (paid > 0) return "PARTIAL";
  return "UNPAID";
}

// Recompute header subtotal/total from the live line items (tax left as-is).
async function recomputeTotals(db: Db, invoiceId: string): Promise<void> {
  const items = await db
    .select({ lt: scm_purchase_invoice_items.line_total_centi })
    .from(scm_purchase_invoice_items)
    .where(eq(scm_purchase_invoice_items.invoice_id, invoiceId));
  const subtotal = items.reduce((s, it) => s + (it.lt || 0), 0);
  const [hdr] = await db
    .select({
      tax: scm_purchase_invoices.tax_centi,
      paid: scm_purchase_invoices.amount_paid_centi,
      status: scm_purchase_invoices.status,
    })
    .from(scm_purchase_invoices)
    .where(eq(scm_purchase_invoices.id, invoiceId));
  const tax = hdr?.tax || 0;
  const total = subtotal + tax;
  const data: Record<string, unknown> = {
    subtotal_centi: subtotal,
    total_centi: total,
    updated_at: new Date(),
  };
  // Keep status coherent with the new total unless the invoice is cancelled.
  if (hdr && hdr.status !== "CANCELLED") {
    data.status = paymentStatus(hdr.paid || 0, total);
  }
  await db
    .update(scm_purchase_invoices)
    .set(data as any)
    .where(eq(scm_purchase_invoices.id, invoiceId));
}

// PI-YYYY-NNNN, per-year sequence. Unique constraint + 409 retry guards races.
async function genInvoiceNumber(db: Db): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `PI-${year}-`;
  const rows = await db
    .select({ n: scm_purchase_invoices.invoice_number })
    .from(scm_purchase_invoices)
    .where(ilike(scm_purchase_invoices.invoice_number, `${prefix}%`));
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)$/.exec(r.n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// ── list ────────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const db = getDb(c.env);
  const search = c.req.query("search")?.trim();
  const status = c.req.query("status")?.trim();
  const page = Math.max(parseInt(c.req.query("page") || "1", 10), 1);
  const perPage = Math.min(Math.max(parseInt(c.req.query("per_page") || "50", 10), 1), 200);

  const conds = [];
  if (status) conds.push(eq(scm_purchase_invoices.status, status));
  if (search) {
    const s = `%${search}%`;
    conds.push(
      or(
        ilike(scm_purchase_invoices.invoice_number, s),
        ilike(scm_purchase_invoices.supplier_invoice_no, s),
      ),
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scm_purchase_invoices)
    .where(where);

  const rows = await db
    .select({
      id: scm_purchase_invoices.id,
      invoice_number: scm_purchase_invoices.invoice_number,
      supplier_invoice_no: scm_purchase_invoices.supplier_invoice_no,
      supplier_id: scm_purchase_invoices.supplier_id,
      supplier_name: scm_suppliers.name,
      purchase_order_id: scm_purchase_invoices.purchase_order_id,
      po_number: scm_purchase_orders.po_number,
      invoice_date: scm_purchase_invoices.invoice_date,
      due_date: scm_purchase_invoices.due_date,
      currency: scm_purchase_invoices.currency,
      total_centi: scm_purchase_invoices.total_centi,
      amount_paid_centi: scm_purchase_invoices.amount_paid_centi,
      status: scm_purchase_invoices.status,
    })
    .from(scm_purchase_invoices)
    .leftJoin(scm_suppliers, eq(scm_purchase_invoices.supplier_id, scm_suppliers.id))
    .leftJoin(
      scm_purchase_orders,
      eq(scm_purchase_invoices.purchase_order_id, scm_purchase_orders.id),
    )
    .where(where)
    .orderBy(desc(scm_purchase_invoices.invoice_date), desc(scm_purchase_invoices.created_at))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return c.json({ data: rows, page, per_page: perPage, total: count });
});

// ── single ──────────────────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [invoice] = await db
    .select()
    .from(scm_purchase_invoices)
    .where(eq(scm_purchase_invoices.id, id));
  if (!invoice) return c.json({ error: "Invoice not found" }, 404);
  const [supplier] = await db
    .select()
    .from(scm_suppliers)
    .where(eq(scm_suppliers.id, invoice.supplier_id));
  let purchase_order = null;
  if (invoice.purchase_order_id) {
    const [po] = await db
      .select()
      .from(scm_purchase_orders)
      .where(eq(scm_purchase_orders.id, invoice.purchase_order_id));
    purchase_order = po ?? null;
  }
  const items = await db
    .select()
    .from(scm_purchase_invoice_items)
    .where(eq(scm_purchase_invoice_items.invoice_id, id))
    .orderBy(asc(scm_purchase_invoice_items.created_at));
  return c.json({ invoice, supplier: supplier ?? null, purchase_order, items });
});

// ── create ──────────────────────────────────────────────────────────────
app.post("/", async (c) => {
  const db = getDb(c.env);
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = purchaseInvoiceCreateSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: parsed.error.issues[0]?.message || "Invalid invoice" }, 400);
  const d = parsed.data;

  const [supplier] = await db
    .select()
    .from(scm_suppliers)
    .where(eq(scm_suppliers.id, d.supplier_id));
  if (!supplier) return c.json({ error: "Supplier not found" }, 404);

  let subtotal = 0;
  const itemRows = d.items.map((it) => {
    const lt = lineTotal(
      Number(it.qty),
      Number(it.unit_price_centi ?? 0),
      Number(it.discount_centi ?? 0),
    );
    subtotal += lt;
    return {
      material_kind: it.material_kind ?? "mfg_product",
      material_code: it.material_code,
      material_name: it.material_name ?? it.material_code,
      qty: it.qty,
      unit_price_centi: it.unit_price_centi ?? 0,
      discount_centi: it.discount_centi ?? 0,
      line_total_centi: lt,
      notes: it.notes ?? null,
    };
  });
  const tax = d.tax_centi ?? 0;
  const invoiceNumber = await genInvoiceNumber(db);

  try {
    const [invoice] = await db
      .insert(scm_purchase_invoices)
      .values({
        invoice_number: invoiceNumber,
        supplier_invoice_no: d.supplier_invoice_no ?? null,
        supplier_id: d.supplier_id,
        purchase_order_id: d.purchase_order_id ?? null,
        invoice_date: d.invoice_date || undefined,
        due_date: d.due_date ?? null,
        currency: d.currency || supplier.currency || "MYR",
        subtotal_centi: subtotal,
        tax_centi: tax,
        total_centi: subtotal + tax,
        amount_paid_centi: 0,
        status: "UNPAID",
        notes: d.notes ?? null,
        created_by: userId ?? null,
      } as any)
      .returning();
    await db
      .insert(scm_purchase_invoice_items)
      .values(itemRows.map((r) => ({ ...r, invoice_id: invoice.id })) as any);
    return c.json({ invoice }, 201);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/unique|duplicate/i.test(msg))
      return c.json({ error: "Invoice number clash — please retry" }, 409);
    return c.json({ error: msg }, 500);
  }
});

// ── update header / record payment / status ─────────────────────────────────
const HDR_FIELDS = [
  "supplier_invoice_no",
  "invoice_date",
  "due_date",
  "notes",
  "tax_centi",
] as const;
app.patch("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [invoice] = await db
    .select()
    .from(scm_purchase_invoices)
    .where(eq(scm_purchase_invoices.id, id));
  if (!invoice) return c.json({ error: "Invoice not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = purchaseInvoiceUpdateSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: parsed.error.issues[0]?.message || "Invalid invoice" }, 400);
  const d = parsed.data as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  for (const f of HDR_FIELDS) if (d[f] !== undefined) data[f] = d[f];

  // Resolve the working total (tax change recomputes it from the live subtotal).
  let total = invoice.total_centi;
  if (d.tax_centi !== undefined) {
    const items = await db
      .select({ lt: scm_purchase_invoice_items.line_total_centi })
      .from(scm_purchase_invoice_items)
      .where(eq(scm_purchase_invoice_items.invoice_id, id));
    const subtotal = items.reduce((s, it) => s + (it.lt || 0), 0);
    total = subtotal + Number(d.tax_centi || 0);
    data.subtotal_centi = subtotal;
    data.total_centi = total;
  }

  // Payment + status. An explicit status wins (e.g. CANCELLED / reopen); else a
  // changed amount_paid_centi re-derives UNPAID/PARTIAL/PAID against the total.
  const paid = d.amount_paid_centi !== undefined ? Number(d.amount_paid_centi) : invoice.amount_paid_centi;
  if (d.amount_paid_centi !== undefined) data.amount_paid_centi = paid;
  if (d.status !== undefined) {
    data.status = d.status;
  } else if (d.amount_paid_centi !== undefined && invoice.status !== "CANCELLED") {
    data.status = paymentStatus(paid, total);
  } else if (d.tax_centi !== undefined && invoice.status !== "CANCELLED") {
    data.status = paymentStatus(paid, total);
  }

  data.updated_at = new Date();
  await db
    .update(scm_purchase_invoices)
    .set(data as any)
    .where(eq(scm_purchase_invoices.id, id));

  const [fresh] = await db
    .select()
    .from(scm_purchase_invoices)
    .where(eq(scm_purchase_invoices.id, id));
  return c.json({ invoice: fresh });
});

// ── delete (cascades items) ─────────────────────────────────────────────────
app.delete("/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const [invoice] = await db
    .delete(scm_purchase_invoices)
    .where(eq(scm_purchase_invoices.id, id))
    .returning();
  if (!invoice) return c.json({ error: "Invoice not found" }, 404);
  return c.json({ ok: true });
});

export default app;
