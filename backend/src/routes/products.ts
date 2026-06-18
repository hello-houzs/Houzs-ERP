// ----------------------------------------------------------------------------
// /products — RETAIL/POS SKU master (distinct from /mfg-products, the
// manufacturer SKU master). 1:1 clone of 2990s apps/api/src/routes/products.ts.
//
// SEAMS (canonical rules): getDb(c.env) (rule #3); requirePermission("*") (rule
// #4); camelCase Drizzle rows -> snake_case wire shape (rule #7).
//
// 2990s's POST delegated to the `create_product_with_pricing` Postgres RPC
// (migration 0004), which atomically inserts the product + the per-product
// pricing rows matching its pricing_kind. Houzs has no Postgres RPCs (Drizzle-
// over-Hyperdrive), so this route TRANSLATES that RPC into a Drizzle transaction
// that does the same inserts. Same request body (validated by the shared
// productSchema), same 201 { id } response.
//
// Endpoints:
//   GET  /products  — visible products + category/series summaries
//   POST /products  — create product + per-product pricing rows (atomic)
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { productSchema } from "@shared/schemas/product";
import type { Env } from "../types";
import { getDb } from "../db/client";
import {
  products as productsTable,
  categories as categoriesTable,
  series as seriesTable,
  productCompartments,
  productBundles,
  productFabrics,
  productSizeVariants,
} from "../db/schema";
import { requirePermission } from "../middleware/auth";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requirePermission("*"));

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "23505");
}

// ── GET / ────────────────────────────────────────────────────────────
// 2990s embedded category:categories(...) + series:series(...) via PostgREST.
// Reproduce with two left joins; same nested `category` / `series` shape.
app.get("/", async (c) => {
  const db = getDb(c.env);
  try {
    const rows = await db
      .select({
        id: productsTable.id,
        sku: productsTable.sku,
        name: productsTable.name,
        detail: productsTable.detail,
        size_display: productsTable.sizeDisplay,
        img_key: productsTable.imgKey,
        thumb_key: productsTable.thumbKey,
        pricing_kind: productsTable.pricingKind,
        flat_price: productsTable.flatPrice,
        recliner_upgrade_price: productsTable.reclinerUpgradePrice,
        stock: productsTable.stock,
        low_at: productsTable.lowAt,
        visible: productsTable.visible,
        cat_id: categoriesTable.id,
        cat_label: categoriesTable.label,
        cat_icon: categoriesTable.icon,
        cat_tbc: categoriesTable.tbc,
        ser_id: seriesTable.id,
        ser_label: seriesTable.label,
        ser_active: seriesTable.active,
      })
      .from(productsTable)
      .leftJoin(categoriesTable, eq(productsTable.categoryId, categoriesTable.id))
      .leftJoin(seriesTable, eq(productsTable.seriesId, seriesTable.id))
      .where(eq(productsTable.visible, true))
      .orderBy(desc(productsTable.updatedAt));

    const data = rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      detail: r.detail,
      size_display: r.size_display,
      img_key: r.img_key,
      thumb_key: r.thumb_key,
      pricing_kind: r.pricing_kind,
      flat_price: r.flat_price,
      recliner_upgrade_price: r.recliner_upgrade_price,
      stock: r.stock,
      low_at: r.low_at,
      visible: r.visible,
      category: r.cat_id ? { id: r.cat_id, label: r.cat_label, icon: r.cat_icon, tbc: r.cat_tbc } : null,
      series: r.ser_id ? { id: r.ser_id, label: r.ser_label, active: r.ser_active } : null,
    }));
    return c.json({ products: data });
  } catch (e) {
    return c.json({ error: "load_failed", reason: errMsg(e) }, 500);
  }
});

// ── POST / ───────────────────────────────────────────────────────────
// Create a product + its per-pricing-kind rows in one transaction (the Drizzle
// translation of the create_product_with_pricing RPC).
app.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const parsed = productSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      400,
    );
  }
  const p = parsed.data;
  const db = getDb(c.env);

  try {
    const id = await db.transaction(async (tx) => {
      const baseRow = {
        sku: p.sku,
        categoryId: p.categoryId,
        seriesId: p.seriesId ?? null,
        pricingKind: p.pricingKind,
        name: p.name,
        detail: p.detail ?? null,
        sizeDisplay: p.sizeDisplay ?? null,
        depthOptions: p.depthOptions ?? null,
        imgKey: p.imgKey ?? null,
        thumbKey: p.thumbKey ?? null,
        stock: p.stock,
        lowAt: p.lowAt,
        visible: p.visible,
        flatPrice: p.pricingKind === "flat" ? p.flatPrice : null,
        reclinerUpgradePrice: p.pricingKind === "sofa_build" ? p.reclinerUpgradePrice : null,
        seatUpgradeLabel: p.pricingKind === "sofa_build" ? p.seatUpgradeLabel ?? null : null,
        seatUpgradeFootrest: p.pricingKind === "sofa_build" ? p.seatUpgradeFootrest ?? true : true,
      };
      const inserted = await tx.insert(productsTable).values(baseRow).returning({ id: productsTable.id });
      const productId = inserted[0].id;

      if (p.pricingKind === "sofa_build") {
        if (p.compartments.length > 0) {
          await tx.insert(productCompartments).values(
            p.compartments.map((r) => ({
              productId,
              compartmentId: r.compartmentId,
              active: r.active,
              price: r.price,
            })),
          );
        }
        if (p.bundles.length > 0) {
          await tx.insert(productBundles).values(
            p.bundles.map((r) => ({ productId, bundleId: r.bundleId, active: r.active, price: r.price })),
          );
        }
        if (p.fabrics.length > 0) {
          await tx.insert(productFabrics).values(
            p.fabrics.map((r) => ({ productId, fabricId: r.fabricId, active: r.active, surcharge: r.surcharge })),
          );
        }
      } else if (p.pricingKind === "size_variants" || p.pricingKind === "bedframe_build") {
        if (p.sizes.length > 0) {
          await tx.insert(productSizeVariants).values(
            p.sizes.map((r) => ({ productId, sizeId: r.sizeId, active: r.active, price: r.price })),
          );
        }
      }
      return productId;
    });

    return c.json({ id }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return c.json({ error: "duplicate_sku", reason: errMsg(e) }, 409);
    return c.json({ error: "create_failed", reason: errMsg(e) }, 500);
  }
});

export default app;
