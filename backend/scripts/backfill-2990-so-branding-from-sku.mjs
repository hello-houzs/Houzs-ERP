#!/usr/bin/env node
// Fill blank branding on company_2 (2990) so the SO list Branding pill shows.
// Owner 2026-07-23: most 2990 SOs read "—". The list derives the pill from the
// first MAIN line's branding (mattress falls back to the SKU brand). The 68
// imported SOs' sofa/bedframe lines are blank AND their SKUs are blank, so
// nothing resolves.
//
// The dry-run proved every blank line is SOFA or BEDFRAME — and 2990 has EXACTLY
// ONE sofa brand ("2990s Sofa") and ONE bedframe brand ("Bedframe") in its
// dropdown. So this is DETERMINISTIC, not a guess: SOFA -> the sole sofa brand,
// BEDFRAME -> the sole bedframe brand. MATTRESS is NOT filled here (three
// brands = ambiguous) and anything else is left; both are reported.
//
// Fills the SKU (mfg_products.branding) AND the SO line
// (mfg_sales_order_items.branding), so the source of truth is right and new
// orders auto-derive correctly. Blank-only, idempotent. DRY-RUN unless APPLY=1.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const blank = (v) => v == null || String(v).trim() === "";
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const normCat = (raw) => { const g = String(raw ?? "").trim().toUpperCase();
  if (g.includes("BEDFRAME")) return "BEDFRAME"; if (g.includes("SOFA")) return "SOFA";
  if (g.includes("MATTRESS")) return "MATTRESS"; if (g.includes("ACCESSOR")) return "ACCESSORY";
  if (g.includes("SERVICE")) return "SERVICE"; return "OTHERS"; };

async function main() {
  const [c] = await dst`SELECT id FROM companies WHERE code='2990'`;
  const cid = Number(c.id);
  log(`2990 company_id=${cid}  mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  // Canonical brands: find the SINGLE sofa brand + SINGLE bedframe brand.
  const brands = (await dst`SELECT name FROM project_brands WHERE company_id=${cid} AND active=1`).map((b) => b.name);
  const sofaBrand = brands.find((b) => norm(b).includes("sofa")) ?? null;
  const bedframeBrand = brands.find((b) => norm(b).includes("bedframe")) ?? null;
  log(`canonical sofa brand="${sofaBrand}"  bedframe brand="${bedframeBrand}"`);
  if (!sofaBrand || !bedframeBrand) { log("missing a sofa/bedframe canonical brand — refusing to run"); return; }

  // Deterministic category -> brand for the single-brand categories. Returns the
  // brand to write, or null to LEAVE (mattress = ambiguous, others = no brand).
  const brandFor = (cat, skuBranding) => {
    if (cat === "SOFA") return sofaBrand;
    if (cat === "BEDFRAME") return bedframeBrand;
    return blank(skuBranding) ? null : skuBranding.trim(); // mattress/other: only if SKU already has one
  };

  // Catalog: code -> {category, branding, name}.
  const prod = await dst`SELECT code, branding, category, name FROM scm.mfg_products WHERE company_id=${cid}`;
  const pBrand = new Map(), pCat = new Map(), pName = new Map();
  for (const p of prod) { if (!blank(p.branding)) pBrand.set(p.code, p.branding.trim()); pCat.set(p.code, normCat(p.category)); pName.set(p.code, p.name); }

  // 1) mfg_products: fill blank SOFA/BEDFRAME SKU branding (source of truth).
  const prodUpd = new Map();
  for (const p of prod) {
    if (!blank(p.branding)) continue;
    const cat = normCat(p.category);
    const b = brandFor(cat, null);
    if (b) prodUpd.set(p.code, b);
  }
  const prodByBrand = new Map();
  for (const b of prodUpd.values()) prodByBrand.set(b, (prodByBrand.get(b) ?? 0) + 1);
  log("");
  log(`=== mfg_products: would fill ${prodUpd.size} blank SKU brandings ===`);
  for (const [b, n] of prodByBrand) log(`  -> "${b}"  (${n} SKUs)`);

  // 2) mfg_sales_order_items: fill blank line branding.
  const lines = await dst`
    SELECT i.id, i.item_code, i.item_group
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
     WHERE o.company_id=${cid} AND (i.branding IS NULL OR btrim(i.branding)='')`;
  const lineUpd = new Map(); const leaveByCat = new Map();
  for (const ln of lines) {
    const cat = (ln.item_code && pCat.get(ln.item_code)) ?? normCat(ln.item_group);
    const sku = ln.item_code ? (prodUpd.get(ln.item_code) ?? pBrand.get(ln.item_code)) : undefined;
    const b = brandFor(cat, sku);
    if (b) lineUpd.set(ln.id, b);
    else leaveByCat.set(cat, (leaveByCat.get(cat) ?? 0) + 1);
  }
  const lineByBrand = new Map();
  for (const b of lineUpd.values()) lineByBrand.set(b, (lineByBrand.get(b) ?? 0) + 1);
  log("");
  log(`=== SO lines: would fill ${lineUpd.size} of ${lines.length} blank lines ===`);
  for (const [b, n] of lineByBrand) log(`  -> "${b}"  (${n} lines)`);
  if (leaveByCat.size) { log("  LEAVE (ambiguous / no brand — report):"); for (const [cat, n] of leaveByCat) log(`    ${cat}: ${n} lines`); }

  if (!APPLY) { log(""); log("DRY-RUN — no writes. APPLY=1 to fill."); return; }
  let a = 0, b2 = 0;
  for (const [code, br] of prodUpd) { await dst`UPDATE scm.mfg_products SET branding=${br} WHERE company_id=${cid} AND code=${code} AND (branding IS NULL OR btrim(branding)='')`; a++; }
  for (const [id, br] of lineUpd) { await dst`UPDATE scm.mfg_sales_order_items SET branding=${br} WHERE id=${id}`; b2++; }
  log("");
  log(`APPLIED: ${a} SKU brandings + ${b2} SO-line brandings.`);
}
main().then(() => dst.end()).catch(async (e) => { console.error("SO_BRANDING_FAIL", e.message); try { await dst.end(); } catch {} process.exit(1); });
