// ----------------------------------------------------------------------------
// /inventory — trading-company stock model w/ FIFO COGS (PR #37).
//
// Two warehouses (KL + 2990 PJ) by default — CRUD via /inventory/warehouses.
// Balance = SUM(movements) via the inventory_balances VIEW.
// COGS = FIFO consumption of lots, maintained by trg_inventory_movement_fifo.
//
// Endpoints:
//   GET   /inventory/warehouses               — list
//   POST  /inventory/warehouses               — create
//   PATCH /inventory/warehouses/:id           — update / toggle active
//   GET   /inventory                          — balance per (warehouse, product)
//                                                ?category=BEDFRAME&warehouseId&search
//                                                ?showAll=true → LEFT JOIN every SKU
//   GET   /inventory/movements                — ledger (filtered)
//   GET   /inventory/lots/:productCode        — FIFO lots for one product
//   GET   /inventory/batches                  — open lots grouped by (warehouse, batch)
//                                                ?warehouseId&productCode (Stage 2 sofa batch view)
//   GET   /inventory/cogs                     — COGS stream (consumption flat list)
//   GET   /inventory/value                    — inventory valuation (qty × cost)
//   POST  /inventory/adjustments              — manual correction
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import {
  isAdjustmentReasonCode,
  computeVariantKey,
  adjustmentIncreaseErrors,
  type VariantAttrs,
} from '../shared';
import { supabaseAuth } from '../middleware/auth';
import { escapeForOr } from '../lib/postgrest-search';
import { recomputeSoStockAllocation } from '../lib/so-stock-allocation';
import type { Env, Variables } from '../env';

export const inventory = new Hono<{ Bindings: Env; Variables: Variables }>();
inventory.use('*', supabaseAuth);

/* ── Warehouses CRUD ─────────────────────────────────────────────────── */
inventory.get('/warehouses', async (c) => {
  const sb = c.get('supabase');
  const includeInactive = c.req.query('includeInactive') === 'true';
  let q = sb.from('warehouses')
    .select('id, code, name, location, is_active, is_default')
    .order('code');
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ warehouses: data ?? [] });
});

inventory.post('/warehouses', async (c) => {
  const sb = c.get('supabase');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const code = String(body.code ?? '').trim().toUpperCase();
  const name = String(body.name ?? '').trim();
  if (!code) return c.json({ error: 'code_required' }, 400);
  if (!name) return c.json({ error: 'name_required' }, 400);

  const { data, error } = await sb.from('warehouses').insert({
    code, name,
    location: (body.location as string) ?? null,
    is_active: body.isActive === false ? false : true,
    is_default: body.isDefault === true,
  }).select('id, code, name, location, is_active, is_default').single();
  if (error) {
    if (error.code === '23505') return c.json({ error: 'duplicate_code' }, 409);
    return c.json({ error: 'insert_failed', reason: error.message }, 500);
  }
  /* Audit 2026-06-20 — enforce a SINGLE default warehouse: clear is_default on
     every other row when this one is set default. Two defaults make
     defaultWarehouseId() (maybeSingle) error → null, breaking the warehouse
     fallback on GRN/DO/return/consignment posts. */
  if (body.isDefault === true) {
    await sb.from('warehouses').update({ is_default: false })
      .eq('is_default', true).neq('id', (data as { id: string }).id);
  }
  return c.json({ warehouse: data }, 201);
});

inventory.patch('/warehouses/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }
  const updates: Record<string, unknown> = {};
  if (typeof body.code === 'string')      updates.code = body.code.trim().toUpperCase();
  if (typeof body.name === 'string')      updates.name = body.name.trim();
  if (typeof body.location === 'string')  updates.location = body.location;
  if (typeof body.isActive === 'boolean') updates.is_active = body.isActive;
  if (typeof body.isDefault === 'boolean') updates.is_default = body.isDefault;
  if (Object.keys(updates).length === 0) return c.json({ error: 'no_changes' }, 400);

  const { data, error } = await sb.from('warehouses').update(updates).eq('id', id)
    .select('id, code, name, location, is_active, is_default').single();
  if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  /* Audit 2026-06-20 — single-default enforcement (see POST): promoting this
     warehouse to default demotes every other one. */
  if (updates.is_default === true) {
    await sb.from('warehouses').update({ is_default: false })
      .eq('is_default', true).neq('id', id);
  }
  return c.json({ warehouse: data });
});

/* Task #121 — Hard DELETE of a warehouse. Used by the inline Warehouses
   table on /mfg-sales-orders/maintenance so a coordinator can drop a
   row they just typed by mistake. Postgres FKs from inventory_movements
   / lots / cogs reject the delete when there's referenced history;
   commander should toggle is_active=false via PATCH in that case. We
   surface the FK error so the UI can hint at deactivate instead. */
inventory.delete('/warehouses/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const { error } = await sb.from('warehouses').delete().eq('id', id);
  if (error) {
    // 23503 = foreign_key_violation — there are movements/lots/etc. tied
    // to this warehouse. Bubble up so the client can show a friendlier
    // "deactivate instead" path.
    if (error.code === '23503') return c.json({ error: 'in_use', reason: error.message }, 409);
    return c.json({ error: 'delete_failed', reason: error.message }, 500);
  }
  return c.json({ ok: true });
});

/* ── Balances ─────────────────────────────────────────────────────────── */
// When showAll=true, returns one row per (warehouse × SKU) including
// zero-balance rows — the UI uses this for the "all SKUs" view.
// When showAll=false (default), returns only rows with movements.
inventory.get('/', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const search = c.req.query('search');
  const category = c.req.query('category');
  const showAll = c.req.query('showAll') === 'true';

  const tableName = showAll ? 'v_inventory_all_skus' : 'inventory_balances';
  // showAll = catalog rollup (one row per SKU incl. zero, product_code level).
  // default = live balances, now one row per (warehouse, product_code,
  // variant_key) so the UI can break a SKU into its attribute-composition rows.
  const cols = showAll
    ? 'warehouse_id, warehouse_code, warehouse_name, product_code, product_name, category, size_label, qty, last_movement_at, value_sen, main_supplier_code, main_supplier_name'
    : 'warehouse_id, product_code, variant_key, product_name, qty, last_movement_at';

  let q = sb.from(tableName).select(cols);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  if (search) { const s = escapeForOr(search); if (s) q = q.or(`product_code.ilike.%${s}%,product_name.ilike.%${s}%`); }
  if (showAll && category && category !== 'all') q = q.eq('category', category);

  // High bound (5000 ≫ catalog) so PostgREST's default 1000-row cap can't
  // silently truncate stock balances — partial stock reads like MISSING stock.
  // The limit caps the absolute max; any ?warehouseId/?search/?category filter
  // applied above only narrows the set, so filtered views stay correct.
  const { data, error } = await q.order('product_code').limit(5000);
  if (error) {
    if (/relation .* does not exist/i.test(error.message) || /column .* does not exist/i.test(error.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run migrations 0050 + 0053 against Supabase.' }, 500);
    }
    return c.json({ error: 'load_failed', reason: error.message }, 500);
  }

  /* Show active warehouses PLUS consignment/showroom warehouses (those are kept
     is_active=false so they stay out of the normal GRN/DO pickers) — so consigned
     stock sitting at a showroom is visible in Inventory. (2026-06-05) */
  const { data: whs } = await sb.from('warehouses')
    .select('id, code, name, is_consignment')
    .or('is_active.eq.true,is_consignment.eq.true');
  return c.json({ balances: data ?? [], warehouses: whs ?? [] });
});

/* ── Product totals (AutoCount-style list view) — PR #38 ─────────────────
   One row per product_code with summed qty across all warehouses + main
   supplier. Double-click a row in the UI to drill into per-warehouse
   breakdown via GET /inventory?showAll=true&search=... */
inventory.get('/products', async (c) => {
  const sb = c.get('supabase');
  const search = c.req.query('search');
  const category = c.req.query('category');

  let q = sb.from('v_inventory_product_totals').select('*');
  if (search) { const s = escapeForOr(search); if (s) q = q.or(`product_code.ilike.%${s}%,product_name.ilike.%${s}%`); }
  if (category && category !== 'all') q = q.eq('category', category);

  // High bound (5000 ≫ catalog) so PostgREST's default 1000-row cap can't
  // silently truncate product totals — partial stock reads like MISSING stock.
  // The limit caps the absolute max; any ?search/?category filter applied above
  // only narrows the set, so filtered views stay correct.
  const { data, error } = await q.order('product_code').limit(5000);
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run migrations 0050/0053/0054.' }, 500);
    }
    return c.json({ error: 'load_failed', reason: error.message }, 500);
  }

  /* Commander 2026-05-29 — enrich each SKU with the live stock picture:
       reserve 7d/14d  = open Sales-Order demand due within 7 / 14 days
       reserved_total  = all open SO demand (committed to customers)
       available_qty   = stock − reserved_total (what's free to sell)
       incoming_qty    = outstanding PO supply (qty − received) coming in
       oldest_lot_at   = the oldest open FIFO lot → "age" of the stock
     Computed by SKU code across all variants (the list is one row per SKU). */
  const products = (data ?? []) as Array<Record<string, unknown>>;
  const codes = products.map((p) => String(p.product_code));
  const SO_DONE = new Set(['DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED']);
  const todayMY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const plus = (n: number): string => {
    const d = new Date(`${todayMY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const d7 = plus(7), d14 = plus(14);

  const reserve7 = new Map<string, number>();
  const reserve14 = new Map<string, number>();
  const reservedTotal = new Map<string, number>();
  const incoming = new Map<string, number>();
  const oldestLot = new Map<string, string>();

  if (codes.length > 0) {
    const { data: demand } = await sb
      .from('mfg_sales_order_items')
      .select('item_code, qty, line_delivery_date, cancelled, so:mfg_sales_orders!inner(status, customer_delivery_date)')
      .in('item_code', codes).eq('cancelled', false).limit(5000);
    for (const r of (demand ?? []) as Array<{ item_code: string; qty: number; line_delivery_date: string | null; so: { status: string; customer_delivery_date: string | null } | Array<{ status: string; customer_delivery_date: string | null }> | null }>) {
      const so = Array.isArray(r.so) ? r.so[0] : r.so;
      const qty = Number(r.qty ?? 0);
      if (!so || SO_DONE.has(so.status) || qty <= 0) continue;
      const code = r.item_code;
      reservedTotal.set(code, (reservedTotal.get(code) ?? 0) + qty);
      const dd = (r.line_delivery_date ?? so.customer_delivery_date)?.slice(0, 10);
      if (dd) {
        if (dd <= d7) reserve7.set(code, (reserve7.get(code) ?? 0) + qty);
        if (dd <= d14) reserve14.set(code, (reserve14.get(code) ?? 0) + qty);
      }
    }

    const { data: poItems } = await sb
      .from('purchase_order_items')
      .select('material_code, qty, received_qty, po:purchase_orders!inner(status)')
      .in('material_code', codes).limit(5000);
    for (const r of (poItems ?? []) as Array<{ material_code: string; qty: number; received_qty: number | null; po: { status: string } | Array<{ status: string }> | null }>) {
      const po = Array.isArray(r.po) ? r.po[0] : r.po;
      if (!po || (po.status !== 'SUBMITTED' && po.status !== 'PARTIALLY_RECEIVED')) continue;
      const left = Number(r.qty ?? 0) - Number(r.received_qty ?? 0);
      if (left > 0) incoming.set(r.material_code, (incoming.get(r.material_code) ?? 0) + left);
    }

    const { data: lots } = await sb
      .from('v_inventory_lots_open')
      .select('product_code, received_at').in('product_code', codes).limit(5000);
    for (const r of (lots ?? []) as Array<{ product_code: string; received_at: string | null }>) {
      if (!r.received_at) continue;
      const cur = oldestLot.get(r.product_code);
      if (!cur || r.received_at < cur) oldestLot.set(r.product_code, r.received_at);
    }
  }

  const enriched = products.map((p) => {
    const code = String(p.product_code);
    const rt = reservedTotal.get(code) ?? 0;
    return {
      ...p,
      reserve_7d:     reserve7.get(code) ?? 0,
      reserve_14d:    reserve14.get(code) ?? 0,
      reserved_total: rt,
      available_qty:  Number(p.total_qty ?? 0) - rt,
      incoming_qty:   incoming.get(code) ?? 0,
      oldest_lot_at:  oldestLot.get(code) ?? null,
    };
  });
  return c.json({ products: enriched });
});

/* ── Per (warehouse × variant) breakdown for one product (drilldown drawer) ─
   Migration 0095. One row per warehouse + attribute composition, with qty
   (from balances) + value (from open FIFO lots) + a readable variant label
   resolved client-side. This is what powers the SKU → attribute-rows view. */
inventory.get('/breakdown/:productCode', async (c) => {
  const sb = c.get('supabase');
  const productCode = c.req.param('productCode');

  const { data: bal, error: balErr } = await sb.from('inventory_balances')
    .select('warehouse_id, variant_key, qty, last_movement_at')
    .eq('product_code', productCode);
  if (balErr) {
    if (/relation .* does not exist/i.test(balErr.message) || /column .* does not exist/i.test(balErr.message)) {
      return c.json({ error: 'migration_pending', reason: 'Run migration 0095 against Supabase.' }, 500);
    }
    return c.json({ error: 'load_failed', reason: balErr.message }, 500);
  }
  const { data: val } = await sb.from('v_inventory_value')
    .select('warehouse_id, variant_key, value_sen')
    .eq('product_code', productCode);
  const { data: whs } = await sb.from('warehouses').select('id, code, name');

  const whMap = new Map((whs ?? []).map((w: { id: string; code: string; name: string }) => [w.id, w]));
  const valMap = new Map(
    ((val ?? []) as Array<{ warehouse_id: string; variant_key: string; value_sen: number }>)
      .map((v) => [`${v.warehouse_id}|${v.variant_key}`, Number(v.value_sen ?? 0)]),
  );
  const balances = ((bal ?? []) as Array<{ warehouse_id: string; variant_key: string | null; qty: number; last_movement_at: string | null }>)
    .map((b) => {
      const vk = b.variant_key ?? '';
      const w = whMap.get(b.warehouse_id);
      return {
        warehouse_id: b.warehouse_id,
        warehouse_code: w?.code ?? null,
        warehouse_name: w?.name ?? null,
        variant_key: vk,
        product_code: productCode,
        qty: Number(b.qty ?? 0),
        value_sen: valMap.get(`${b.warehouse_id}|${vk}`) ?? 0,
        last_movement_at: b.last_movement_at ?? null,
      };
    });
  return c.json({ balances });
});

inventory.get('/movements', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const productCode = c.req.query('productCode');
  const docType = c.req.query('docType');
  const dateFrom = c.req.query('dateFrom');
  const dateTo = c.req.query('dateTo');
  const limit = Math.min(500, Number(c.req.query('limit') ?? 200));

  let q = sb.from('inventory_movements')
    .select('id, movement_type, warehouse_id, product_code, product_name, qty, unit_cost_sen, total_cost_sen, source_doc_type, source_doc_id, source_doc_no, reason_code, notes, performed_by, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  if (productCode) q = q.eq('product_code', productCode);
  if (docType) q = q.eq('source_doc_type', docType);
  if (dateFrom) q = q.gte('created_at', dateFrom);
  if (dateTo) q = q.lte('created_at', `${dateTo}T23:59:59Z`);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ movements: data ?? [] });
});

/* ── FIFO lots drilldown for one product ─────────────────────────────── */
inventory.get('/lots/:productCode', async (c) => {
  const sb = c.get('supabase');
  const productCode = c.req.param('productCode');
  const warehouseId = c.req.query('warehouseId');
  const includeClosed = c.req.query('includeClosed') === 'true';

  const tbl = includeClosed ? 'inventory_lots' : 'v_inventory_lots_open';
  let q = sb.from(tbl).select('*').eq('product_code', productCode);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  const { data, error } = await q.order('received_at', { ascending: true });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ lots: data ?? [] });
});

/* ── Batch availability (Stage 2 — Commander 2026-05-31) ──────────────────
   Sofa is colour-matched and produced as a SET on ONE PO (one dye lot). Stage 1
   tagged every inbound lot with batch_no = source PO number. This view groups
   the OPEN lots (qty_remaining > 0) by (warehouse, batch) so the outbound side
   can see each batch's surviving component SKUs at a glance — the raw material
   Stage 3 uses to ship a whole set from ONE batch.

   Shape: one row per (warehouse_id, batch_no) with its component SKUs:
     { warehouseId, warehouseName, batchNo, supplierId, supplierName,
       receivedAt (earliest), totalRemaining,
       components: [{ productCode, variantKey, productName, qtyRemaining,
                      unitCostSen, receivedAt }] }
   ?warehouseId filters; ?productCode keeps only batches that still hold that SKU.
   batch_no IS NULL lots (free GRN / un-batched stock) are excluded by design —
   only produced-to-PO stock carries a batch. */
inventory.get('/batches', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const productCode = c.req.query('productCode');

  let q = sb.from('v_inventory_lots_open')
    .select('warehouse_id, batch_no, product_code, variant_key, product_name, qty_remaining, unit_cost_sen, received_at')
    .not('batch_no', 'is', null)
    .gt('qty_remaining', 0);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  const { data: lots, error } = await q.order('received_at', { ascending: true });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type Lot = {
    warehouse_id: string; batch_no: string; product_code: string;
    variant_key: string | null; product_name: string | null;
    qty_remaining: number; unit_cost_sen: number | null; received_at: string | null;
  };
  const rows = (lots ?? []) as Lot[];

  // Warehouse names (small table).
  const { data: whs } = await sb.from('warehouses').select('id, name');
  const whName = new Map<string, string>();
  for (const w of (whs ?? []) as Array<{ id: string; name: string }>) whName.set(w.id, w.name);

  // batch_no = PO number → resolve supplier for display.
  const batchNos = [...new Set(rows.map((r) => r.batch_no))];
  const supplierByPo = new Map<string, { id: string | null; name: string | null }>();
  if (batchNos.length > 0) {
    const { data: pos } = await sb.from('purchase_orders')
      .select('po_number, supplier_id, suppliers(name)')
      .in('po_number', batchNos);
    for (const p of (pos ?? []) as unknown as Array<{ po_number: string; supplier_id: string | null; suppliers: { name: string | null } | { name: string | null }[] | null }>) {
      const sup = Array.isArray(p.suppliers) ? (p.suppliers[0] ?? null) : p.suppliers;
      supplierByPo.set(p.po_number, { id: p.supplier_id ?? null, name: sup?.name ?? null });
    }
  }

  type Component = {
    productCode: string; variantKey: string | null; productName: string | null;
    qtyRemaining: number; unitCostSen: number; receivedAt: string | null;
  };
  type Batch = {
    warehouseId: string; warehouseName: string | null; batchNo: string;
    supplierId: string | null; supplierName: string | null;
    receivedAt: string | null; totalRemaining: number; components: Component[];
  };
  const byBatch = new Map<string, Batch>();
  for (const r of rows) {
    const key = `${r.warehouse_id}|${r.batch_no}`;
    let b = byBatch.get(key);
    if (!b) {
      const sup = supplierByPo.get(r.batch_no) ?? { id: null, name: null };
      b = {
        warehouseId: r.warehouse_id,
        warehouseName: whName.get(r.warehouse_id) ?? null,
        batchNo: r.batch_no,
        supplierId: sup.id,
        supplierName: sup.name,
        receivedAt: r.received_at,
        totalRemaining: 0,
        components: [],
      };
      byBatch.set(key, b);
    }
    // Merge same (product_code, variant_key) lots within a batch into one component.
    const existing = b.components.find((c2) => c2.productCode === r.product_code && (c2.variantKey ?? '') === (r.variant_key ?? ''));
    if (existing) {
      existing.qtyRemaining += r.qty_remaining;
    } else {
      b.components.push({
        productCode: r.product_code,
        variantKey: r.variant_key,
        productName: r.product_name,
        qtyRemaining: r.qty_remaining,
        unitCostSen: Number(r.unit_cost_sen ?? 0),
        receivedAt: r.received_at,
      });
    }
    b.totalRemaining += r.qty_remaining;
    // Keep the earliest received_at on the batch header.
    if (r.received_at && (!b.receivedAt || r.received_at < b.receivedAt)) b.receivedAt = r.received_at;
  }

  let batches = [...byBatch.values()];
  if (productCode) batches = batches.filter((b) => b.components.some((c2) => c2.productCode === productCode));
  // FIFO order — oldest batch first (matches outbound consumption preference).
  batches.sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? ''));

  return c.json({ batches });
});

/* ── COGS stream ─────────────────────────────────────────────────────── */
inventory.get('/cogs', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const productCode = c.req.query('productCode');
  const from = c.req.query('from');
  const to = c.req.query('to');

  let q = sb.from('v_cogs_entries').select('*').limit(1000);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  if (productCode) q = q.eq('product_code', productCode);
  if (from) q = q.gte('consumed_at', from);
  if (to)   q = q.lte('consumed_at', `${to}T23:59:59Z`);

  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ cogs: data ?? [] });
});

/* ── Inventory valuation (qty × cost) ────────────────────────────────── */
inventory.get('/value', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  let q = sb.from('v_inventory_value').select('*');
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  const { data, error } = await q.order('product_code');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ value: data ?? [] });
});

/* ── Inventory analytics / KPI board ─────────────────────────────────────
   Pure read-only reporting computed from open lots + COGS stream. No new
   tables. Returns: stock aging buckets, dead-stock (has stock but no sale in
   the window), turnover + days-on-hand, and an ABC classification by trailing
   sales value. ?days=90 (window), ?warehouseId optional. */
inventory.get('/analytics', async (c) => {
  const sb = c.get('supabase');
  const warehouseId = c.req.query('warehouseId');
  const days = Math.max(1, Math.min(365, Math.round(Number(c.req.query('days') ?? 90)) || 90));
  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - days * 86_400_000).toISOString();

  // Open lots → aging buckets + per-product on-hand value + names.
  let lotsQ = sb.from('v_inventory_lots_open')
    .select('product_code, product_name, qty_remaining, remaining_value_sen, received_at, warehouse_id')
    .limit(50_000);
  if (warehouseId) lotsQ = lotsQ.eq('warehouse_id', warehouseId);
  const { data: lots, error: lotsErr } = await lotsQ;
  if (lotsErr) return c.json({ error: 'load_failed', reason: lotsErr.message }, 500);

  // Full COGS stream → trailing-window sales value per product + all-time last-sold date.
  let cogsQ = sb.from('v_cogs_entries')
    .select('product_code, total_cost_sen, consumed_at, warehouse_id')
    .limit(100_000);
  if (warehouseId) cogsQ = cogsQ.eq('warehouse_id', warehouseId);
  const { data: cogs, error: cogsErr } = await cogsQ;
  if (cogsErr) return c.json({ error: 'load_failed', reason: cogsErr.message }, 500);

  const lotRows = lots ?? [];
  const cogsRows = cogs ?? [];

  // Aging buckets (days since lot received).
  const BUCKETS = [
    { key: '0-30', label: '0–30 days', max: 30 },
    { key: '31-60', label: '31–60 days', max: 60 },
    { key: '61-90', label: '61–90 days', max: 90 },
    { key: '91-180', label: '91–180 days', max: 180 },
    { key: '180+', label: '180+ days', max: Infinity },
  ];
  const aging = BUCKETS.map((b) => ({ key: b.key, label: b.label, qty: 0, valueSen: 0 }));
  // Per-product current on-hand value + name.
  const prod = new Map<string, { name: string; qty: number; valueSen: number }>();
  let totalValueSen = 0;
  for (const l of lotRows) {
    const ageDays = (nowMs - new Date(l.received_at as string).getTime()) / 86_400_000;
    const idx = BUCKETS.findIndex((b) => ageDays <= b.max);
    const bucket = aging[idx < 0 ? aging.length - 1 : idx];
    const qty = Number(l.qty_remaining ?? 0);
    const val = Number(l.remaining_value_sen ?? 0);
    if (bucket) { bucket.qty += qty; bucket.valueSen += val; }
    totalValueSen += val;
    const code = String(l.product_code ?? '');
    const p = prod.get(code) ?? { name: String(l.product_name ?? code), qty: 0, valueSen: 0 };
    p.qty += qty; p.valueSen += val;
    prod.set(code, p);
  }

  // Trailing-window COGS per product + all-time last-sold.
  const trailingCogs = new Map<string, number>();
  const lastSold = new Map<string, string>();
  let trailingCogsTotal = 0;
  for (const e of cogsRows) {
    const code = String(e.product_code ?? '');
    const at = String(e.consumed_at ?? '');
    const prev = lastSold.get(code);
    if (!prev || at > prev) lastSold.set(code, at);
    if (at >= cutoffIso) {
      const v = Number(e.total_cost_sen ?? 0);
      trailingCogs.set(code, (trailingCogs.get(code) ?? 0) + v);
      trailingCogsTotal += v;
    }
  }

  // Turnover + days-on-hand (current value as the average-inventory proxy).
  const annualizedCogs = trailingCogsTotal * (365 / days);
  const turns = totalValueSen > 0 ? annualizedCogs / totalValueSen : 0;
  const daysOnHand = trailingCogsTotal > 0 ? (totalValueSen * days) / trailingCogsTotal : null;

  // Dead stock — has on-hand value but no sale inside the window.
  const deadStock = [...prod.entries()]
    .filter(([code]) => !(trailingCogs.get(code) ?? 0))
    .map(([code, p]) => ({
      product_code: code, product_name: p.name, qty: p.qty, valueSen: p.valueSen,
      lastSoldAt: lastSold.get(code) ?? null,
    }))
    .sort((a, b) => b.valueSen - a.valueSen);

  // ABC — rank every product (stock or sales) by trailing sales value desc.
  const codes = new Set<string>([...prod.keys(), ...trailingCogs.keys()]);
  const ranked = [...codes]
    .map((code) => ({
      product_code: code,
      product_name: prod.get(code)?.name ?? code,
      cogsSen: trailingCogs.get(code) ?? 0,
      onHandValueSen: prod.get(code)?.valueSen ?? 0,
    }))
    .sort((a, b) => b.cogsSen - a.cogsSen);
  const summary = { A: { count: 0, valueSen: 0 }, B: { count: 0, valueSen: 0 }, C: { count: 0, valueSen: 0 } };
  let cum = 0;
  const abcItems = ranked.map((r) => {
    cum += r.cogsSen;
    const cumPct = trailingCogsTotal > 0 ? (cum / trailingCogsTotal) * 100 : 100;
    const cls: 'A' | 'B' | 'C' = cumPct <= 80 ? 'A' : cumPct <= 95 ? 'B' : 'C';
    summary[cls].count += 1;
    summary[cls].valueSen += r.onHandValueSen;
    return { ...r, cumPct, class: cls };
  });

  return c.json({
    asOf: new Date(nowMs).toISOString(),
    windowDays: days,
    totalValueSen,
    distinctSkus: prod.size,
    aging,
    turnover: { trailingCogsSen: trailingCogsTotal, annualizedTurns: turns, daysOnHand },
    deadStock,
    abc: { items: abcItems, summary },
  });
});

/* ── Ledger reconciliation sweep ─────────────────────────────────────────
   Read-only integrity check. Inventory writes are best-effort (a failed
   movement insert does NOT roll back the document), so a doc can be POSTED /
   shipped while its stock movement silently never landed. This flags every
   non-cancelled GRN / DO / Purchase Return / Delivery Return that should have
   moved stock but has ZERO movement rows — the operator can then re-post or
   investigate. (A genuinely zero-qty doc legitimately has none; review each.) */
inventory.get('/reconcile', async (c) => {
  const sb = c.get('supabase');

  const { data: movRows, error: movErr } = await sb.from('inventory_movements')
    .select('source_doc_type, source_doc_id').limit(200_000);
  if (movErr) return c.json({ error: 'load_failed', reason: movErr.message }, 500);
  const hasMov = new Set<string>();
  for (const m of (movRows ?? []) as Array<{ source_doc_type: string | null; source_doc_id: string | null }>) {
    if (m.source_doc_id) hasMov.add(`${m.source_doc_type}::${m.source_doc_id}`);
  }

  const issues: Array<{ docType: string; id: string; docNo: string; status: string }> = [];
  const flag = (docType: string, movType: string, rows: Array<Record<string, string>>, numCol: string) => {
    for (const r of rows) {
      const id = r.id ?? '';
      if (id && !hasMov.has(`${movType}::${id}`)) {
        issues.push({ docType, id, docNo: r[numCol] ?? id, status: r.status ?? '' });
      }
    }
  };

  const SHIPPED = ['DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED'];
  const [grnsR, dosR, prsR, drsR] = await Promise.all([
    sb.from('grns').select('id, grn_number, status').eq('status', 'POSTED').limit(10_000),
    sb.from('delivery_orders').select('id, do_number, status').in('status', SHIPPED).limit(10_000),
    sb.from('purchase_returns').select('id, return_number, status').neq('status', 'CANCELLED').limit(10_000),
    sb.from('delivery_returns').select('id, return_number, status').neq('status', 'CANCELLED').limit(10_000),
  ]);
  flag('GRN', 'GRN', (grnsR.data ?? []) as Array<Record<string, string>>, 'grn_number');
  flag('Delivery Order', 'DO', (dosR.data ?? []) as Array<Record<string, string>>, 'do_number');
  flag('Purchase Return', 'PURCHASE_RETURN', (prsR.data ?? []) as Array<Record<string, string>>, 'return_number');
  flag('Delivery Return', 'DR', (drsR.data ?? []) as Array<Record<string, string>>, 'return_number');

  return c.json({ asOf: new Date().toISOString(), issueCount: issues.length, issues });
});

/* ── Manual adjustment ───────────────────────────────────────────────── */
inventory.post('/adjustments', async (c) => {
  const sb = c.get('supabase'); const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: 'invalid_json' }, 400); }

  if (!body.warehouseId || !body.productCode) return c.json({ error: 'warehouse_and_product_required' }, 400);
  const qtyDelta = Number(body.qtyDelta ?? 0);
  if (!Number.isFinite(qtyDelta) || qtyDelta === 0) return c.json({ error: 'invalid_qty_delta' }, 400);

  // Structured reason is mandatory on a manual adjustment (audit trail).
  // Validated against the shared catalogue — single source of truth shared
  // with the frontend dropdown.
  const reasonCode = String(body.reasonCode ?? '');
  if (!isAdjustmentReasonCode(reasonCode)) return c.json({ error: 'reason_required' }, 400);

  const warehouseId = String(body.warehouseId);
  const productCode = String(body.productCode);
  const itemGroup = (body.itemGroup as string | undefined) ?? null;
  const variants = (body.variants as Record<string, unknown> | null | undefined) ?? null;
  const batchNo = ((body.batchNo as string | undefined) ?? '').trim() || null;

  // Resolve which stock bucket (variant_key + batch_no) this adjustment hits.
  //   • INCREASE behaves like a mini-receipt: compute variant_key from the chosen
  //     attributes (mirrors GRN) and gate on the shared variant+batch rule so the
  //     found stock isn't stranded in the unclassified / no-batch bucket.
  //   • DECREASE targets an EXISTING bucket the operator picked, so it arrives
  //     with an explicit variantKey + batchNo; we only verify enough is on hand
  //     (no orphan / negative bucket).
  let variantKey: string;
  if (qtyDelta > 0) {
    const errs = adjustmentIncreaseErrors(itemGroup, variants, batchNo);
    if (errs.length > 0) return c.json({ error: 'adjustment_incomplete', message: errs.join(' ') }, 422);
    variantKey = body.variantKey != null
      ? String(body.variantKey)
      : computeVariantKey(itemGroup, (variants as VariantAttrs | null) ?? null);
  } else {
    variantKey = String(body.variantKey ?? '');
    let avQ = sb.from('v_inventory_lots_open')
      .select('qty_remaining')
      .eq('warehouse_id', warehouseId)
      .eq('product_code', productCode)
      .eq('variant_key', variantKey);
    avQ = batchNo == null ? avQ.is('batch_no', null) : avQ.eq('batch_no', batchNo);
    const { data: openLots } = await avQ;
    const available = ((openLots ?? []) as Array<{ qty_remaining: number | null }>)
      .reduce((s, l) => s + Number(l.qty_remaining ?? 0), 0);
    if (Math.abs(qtyDelta) > available) {
      return c.json({
        error: 'insufficient_bucket',
        message: `Only ${available} on hand in that batch/variant — you can't take out ${Math.abs(qtyDelta)}.`,
      }, 422);
    }
  }

  const { data, error } = await sb.from('inventory_movements').insert({
    movement_type: 'ADJUSTMENT',
    warehouse_id: warehouseId,
    product_code: productCode,
    // Attribute-composition bucket (migration 0095) + dye-lot batch (0120). An
    // increase computes these from the chosen attributes; a decrease carries the
    // picked existing bucket. The FIFO trigger (0126) honours batch_no on
    // ADJUSTMENT: +qty creates a batched lot, −qty consumes the batch FIFO.
    variant_key: variantKey,
    batch_no: batchNo,
    product_name: (body.productName as string) ?? null,
    qty: qtyDelta,
    unit_cost_sen: Number(body.unitCostSen ?? 0),
    source_doc_type: 'ADJUSTMENT',
    reason_code: reasonCode,
    notes: (body.notes as string) ?? null,
    performed_by: user.id,
  }).select('id').single();
  if (error) return c.json({ error: 'insert_failed', reason: error.message }, 500);
  /* Audit 2026-06-10 #12 — every other stock-mutating path re-walks the SO
     allocation; a manual adjustment was the one forgotten path. A write-off
     left SO lines READY against vanished stock; a found-stock increase didn't
     flip PENDING→READY until some unrelated document touched stock. */
  try { await recomputeSoStockAllocation(sb); } catch { /* best-effort */ }
  return c.json({ movement: data }, 201);
});

/* ── Open stock buckets for one product (decrease-adjustment picker) ───────
   Groups the OPEN lots (qty_remaining > 0) of one SKU by (variant_key, batch_no)
   so a manual DECREASE adjustment can target the EXACT bucket it takes stock
   from — never into a non-existent or wrong-attribute/-batch bucket. ?warehouseId
   scopes to one warehouse. */
inventory.get('/buckets/:productCode', async (c) => {
  const sb = c.get('supabase');
  const productCode = c.req.param('productCode');
  const warehouseId = c.req.query('warehouseId');

  let q = sb.from('v_inventory_lots_open')
    .select('warehouse_id, variant_key, batch_no, product_name, qty_remaining')
    .eq('product_code', productCode);
  if (warehouseId) q = q.eq('warehouse_id', warehouseId);
  const { data, error } = await q;
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type Lot = {
    warehouse_id: string; variant_key: string | null; batch_no: string | null;
    product_name: string | null; qty_remaining: number | null;
  };
  const byBucket = new Map<string, {
    warehouse_id: string; variant_key: string; batch_no: string | null;
    product_name: string | null; qty: number;
  }>();
  for (const l of (data ?? []) as Lot[]) {
    const vk = l.variant_key ?? '';
    const bn = l.batch_no ?? null;
    const key = `${l.warehouse_id}|${vk}|${bn ?? ''}`;
    const cur = byBucket.get(key);
    if (cur) cur.qty += Number(l.qty_remaining ?? 0);
    else byBucket.set(key, { warehouse_id: l.warehouse_id, variant_key: vk, batch_no: bn, product_name: l.product_name, qty: Number(l.qty_remaining ?? 0) });
  }
  const buckets = [...byBucket.values()]
    .filter((b) => b.qty > 0)
    .sort((a, b) => (a.batch_no ?? '').localeCompare(b.batch_no ?? '') || a.variant_key.localeCompare(b.variant_key));
  return c.json({ buckets });
});
