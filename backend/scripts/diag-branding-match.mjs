#!/usr/bin/env node
// Read-only. Owner 2026-07-23: many mfg_products / product_models / SO-line
// `branding` values are FREE TEXT that don't match the maintained dropdown
// (public.project_brands). Before backfilling them to canonical values we
// need to SEE the gap. This prints, for company_id=2 (2990):
//
//   1. CANONICAL — every project_brands row (the dropdown the owner maintains)
//   2. mfg_products.branding — DISTINCT value x category, with a row count and
//      a classification: EXACT (already canonical, case-insensitive) /
//      MAP -> <proposed canonical> / NO-MATCH (needs an owner decision) / BLANK
//   3. product_models.branding — same
//   4. mfg_sales_order_items.branding — same (what shows on the SO list)
//
// The proposed mapping is a SUGGESTION only — it normalizes case/spacing and
// matches against canonical by (a) exact, (b) canonical-startswith-freetext or
// vice-versa, (c) category hint (a MATTRESS SKU's "CARRES" -> "Carres
// Mattress"). Nothing is written. The owner reviews this table, finalizes the
// canonical list (deletes dups via the new Delete button), and only then do we
// ship the backfill.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const normCat = (raw) => {
  const g = String(raw ?? "").trim().toUpperCase();
  if (g.includes("BEDFRAME")) return "BEDFRAME";
  if (g.includes("SOFA")) return "SOFA";
  if (g.includes("MATTRESS")) return "MATTRESS";
  if (g.includes("ACCESSOR")) return "ACCESSORY";
  return "OTHER";
};

// Propose a canonical brand for a free-text value + category.
function propose(freeText, category, canonicalList) {
  const ft = norm(freeText);
  if (!ft) return { kind: "BLANK", to: null };
  // (a) exact case-insensitive
  const exact = canonicalList.find((c) => norm(c) === ft);
  if (exact) return { kind: "EXACT", to: exact };
  // (b) category-aware: canonical that contains the free text AND matches the
  //     SKU category word (so "2990s" on a SOFA SKU -> "2990s Sofa", on a
  //     MATTRESS SKU -> "2990s Mattress").
  const catWord = category === "SOFA" ? "sofa" : category === "MATTRESS" ? "mattress" : category === "BEDFRAME" ? "bedframe" : null;
  if (catWord) {
    const catMatch = canonicalList.find((c) => {
      const nc = norm(c);
      return nc.includes(catWord) && (nc.includes(ft) || ft.includes(nc.replace(` ${catWord}`, "")));
    });
    if (catMatch) return { kind: "MAP", to: catMatch };
  }
  // (c) loose: canonical starts-with or contains the free text (or vice-versa)
  const loose = canonicalList.find((c) => {
    const nc = norm(c);
    return nc.startsWith(ft) || ft.startsWith(nc) || nc.includes(ft) || ft.includes(nc);
  });
  if (loose) return { kind: "MAP", to: loose };
  return { kind: "NO-MATCH", to: null };
}

async function reportTable(cid, table, joinToSo, canonicalList) {
  notice("");
  notice(`=== ${table}.branding (company_id=${cid}) — DISTINCT value x category ===`);
  const q = joinToSo
    ? `SELECT i.branding AS branding, p.category AS category, count(*)::int AS n
         FROM scm.mfg_sales_order_items i
         JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
         LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = o.company_id
        WHERE o.company_id=${cid}
        GROUP BY i.branding, p.category
        ORDER BY count(*) DESC`
    : `SELECT branding, category, count(*)::int AS n
         FROM scm.${table}
        WHERE company_id=${cid}
        GROUP BY branding, category
        ORDER BY count(*) DESC`;
  const rows = await dst.unsafe(q);
  let exact = 0, map = 0, noMatch = 0, blank = 0;
  for (const r of rows) {
    const cat = normCat(r.category);
    const p = propose(r.branding, cat, canonicalList);
    if (p.kind === "EXACT") exact += r.n;
    else if (p.kind === "MAP") map += r.n;
    else if (p.kind === "NO-MATCH") noMatch += r.n;
    else blank += r.n;
    const arrow = p.to ? ` -> "${p.to}"` : "";
    notice(`  [${p.kind}] branding=${JSON.stringify(r.branding)} cat=${cat} n=${r.n}${arrow}`);
  }
  notice(`  totals: EXACT=${exact}  MAP=${map}  NO-MATCH=${noMatch}  BLANK=${blank}`);
  return { exact, map, noMatch, blank };
}

async function main() {
  const [c2990] = await dst`SELECT id FROM companies WHERE code='2990'`;
  const cid = Number(c2990.id);
  notice(`2990 company_id=${cid}  mode=READ-ONLY`);

  const brands = await dst`
    SELECT name, active FROM project_brands WHERE company_id=${cid} ORDER BY sort_order, name`;
  const canonicalList = brands.map((b) => b.name);
  notice("");
  notice(`=== CANONICAL project_brands (the maintained dropdown), ${brands.length} rows ===`);
  for (const b of brands) notice(`  "${b.name}"${b.active ? "" : "  (HIDDEN)"}`);

  const t1 = await reportTable(cid, "mfg_products", false, canonicalList);
  const t2 = await reportTable(cid, "product_models", false, canonicalList);
  const t3 = await reportTable(cid, "mfg_sales_order_items", true, canonicalList);

  notice("");
  notice("=== SUMMARY (row counts, not distinct values) ===");
  notice(`  mfg_products         EXACT=${t1.exact} MAP=${t1.map} NO-MATCH=${t1.noMatch} BLANK=${t1.blank}`);
  notice(`  product_models       EXACT=${t2.exact} MAP=${t2.map} NO-MATCH=${t2.noMatch} BLANK=${t2.blank}`);
  notice(`  mfg_sales_order_items EXACT=${t3.exact} MAP=${t3.map} NO-MATCH=${t3.noMatch} BLANK=${t3.blank}`);
  notice("");
  notice("Legend: EXACT = already matches the dropdown. MAP = a safe rename to");
  notice("  the proposed canonical. NO-MATCH = the free text has no canonical");
  notice("  counterpart — the owner either adds it to the dropdown or picks the");
  notice("  right brand. BLANK = empty (auto-derive from the SKU on save handles");
  notice("  new ones; a separate backfill can fill historical blanks from the");
  notice("  product catalog). Nothing was written by this script.");
}
main().then(() => dst.end()).catch(async (e) => {
  console.error("DIAG_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
