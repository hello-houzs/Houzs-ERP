#!/usr/bin/env node
// Backfill blank branding on company_2 (2990) SO LINES from the SKU
// (mfg_products.branding by item_code) — the SAME source the write-path
// auto-derive (deriveLineBrandingFromProduct) uses, applied to the imported SOs
// whose lines never ran through it. Owner 2026-07-23: the SO list Branding pill
// is blank for most 2990 SOs; fill it.
//
// The SO-list pill (mfg-sales-orders.ts) reads the first MAIN line's branding
// (mattress falls back to the SKU brand). So filling the LINE branding from the
// SKU makes the pill show. Where the SKU ITSELF has no branding, we CANNOT fill
// (no source, no guess) — the script REPORTS those, broken down by category +
// with model-branding and product-name context, so the owner can see exactly
// which SKUs still need a brand set in maintenance.
//
// SAFE: fills only blank lines, only from a non-blank SKU brand. Idempotent.
// DRY-RUN unless APPLY=1.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const blank = (v) => v == null || String(v).trim() === "";
const normCat = (raw) => { const g = String(raw ?? "").trim().toUpperCase();
  if (g.includes("BEDFRAME")) return "BEDFRAME"; if (g.includes("SOFA")) return "SOFA";
  if (g.includes("MATTRESS")) return "MATTRESS"; if (g.includes("ACCESSOR")) return "ACCESSORY";
  if (g.includes("SERVICE")) return "SERVICE"; return "OTHERS"; };

async function main() {
  const [c] = await dst`SELECT id FROM companies WHERE code='2990'`;
  const cid = Number(c.id);
  log(`2990 company_id=${cid}  mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // Catalog: code -> {branding, category, name} for company_2.
  const prod = await dst`SELECT code, branding, category, name FROM scm.mfg_products WHERE company_id=${cid}`;
  const pBrand = new Map(), pCat = new Map(), pName = new Map();
  for (const p of prod) { if (!blank(p.branding)) pBrand.set(p.code, p.branding.trim()); pCat.set(p.code, normCat(p.category)); pName.set(p.code, p.name); }

  // Blank-branding SO lines for company_2.
  const lines = await dst`
    SELECT i.id, i.doc_no, i.item_code, i.item_group, i.branding
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
     WHERE o.company_id=${cid} AND (i.branding IS NULL OR btrim(i.branding)='')`;
  log(`blank-branding SO lines: ${lines.length}`);

  const updates = new Map(); // id -> brand
  const leaveByCat = new Map(); // cat -> count of lines left (SKU also blank)
  const leaveExamples = [];
  for (const ln of lines) {
    const cat = (ln.item_code && pCat.get(ln.item_code)) ?? normCat(ln.item_group);
    const skuBrand = ln.item_code ? pBrand.get(ln.item_code) : undefined;
    if (skuBrand) { updates.set(ln.id, skuBrand); }
    else {
      leaveByCat.set(cat, (leaveByCat.get(cat) ?? 0) + 1);
      if (leaveExamples.length < 12) leaveExamples.push(`${ln.doc_no} [${cat}] code=${ln.item_code ?? "-"} name="${(ln.item_code && pName.get(ln.item_code)) || "?"}"`);
    }
  }

  // Fill breakdown by target brand.
  const byBrand = new Map();
  for (const b of updates.values()) byBrand.set(b, (byBrand.get(b) ?? 0) + 1);
  log("");
  log(`=== WOULD FILL ${updates.size} lines from SKU branding ===`);
  for (const [b, n] of [...byBrand.entries()].sort((a, z) => z[1] - a[1])) log(`  -> "${b}"  (${n} lines)`);
  log("");
  log(`=== LEAVE ${lines.length - updates.size} lines — SKU itself has NO branding (needs a brand set in Product maintenance) ===`);
  for (const [cat, n] of [...leaveByCat.entries()].sort((a, z) => z[1] - a[1])) log(`  ${cat}: ${n} lines`);
  if (leaveExamples.length) { log("  examples:"); for (const e of leaveExamples) log(`    ${e}`); }

  if (APPLY && updates.size) {
    let done = 0;
    for (const [id, b] of updates) { await dst`UPDATE scm.mfg_sales_order_items SET branding=${b} WHERE id=${id}`; done++; }
    log("");
    log(`APPLIED ${done} line-branding fills.`);
  } else if (!APPLY) {
    log("");
    log("DRY-RUN — no writes. APPLY=1 to fill.");
  }
}
main().then(() => dst.end()).catch(async (e) => { console.error("SO_BRANDING_FAIL", e.message); try { await dst.end(); } catch {} process.exit(1); });
