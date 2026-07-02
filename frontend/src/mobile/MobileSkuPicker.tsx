import { useMemo, useState } from "react";
import { useMfgProducts, type MfgCategory, type MfgProductRow } from "../vendor/scm/lib/mfg-products-queries";
import "./mobile.css";

/* ---------------------------------------------------------------------------
 * MobileSkuPicker — searchable bottom-sheet SKU catalog picker for the mobile
 * Sales Order line editor. Queries the REAL catalog through
 * useMfgProducts({ category, search }) (GET /mfg-products), so a tapped row
 * seeds the line with a genuine item_code + item_group + name (+ the catalog
 * base/selling price shown for reference). The server recomputes the honest
 * price on save — this picker never asserts a price.
 *
 * Category is a FILTER chip row inside the sheet (never a mandatory pre-select
 * that blocks item selection): "All" shows every SKU, tapping a chip narrows
 * the list. Presentation reuses the app's bottom-sheet chrome (.sheet-bd /
 * .sheet / .grab / .sheet-head / .sheet-x / .sheet-scroll) + .searchbar /
 * .chips / .chip classes from mobile.css.
 * ------------------------------------------------------------------------- */

/* The line's category axis maps 1:1 to a catalog category. "" (General item)
   shows every SKU with no category filter. */
export type SkuPickerCat = "" | "sofa" | "bedframe";

const CAT_CHIPS: Array<{ value: MfgCategory | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "SOFA", label: "Sofa" },
  { value: "MATTRESS", label: "Mattress" },
  { value: "ACCESSORY", label: "Accessory" },
];

const fromSen = (sen: number | null | undefined): string =>
  ((sen ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What a picked SKU hands back to the line: the canonical catalog code, the
 *  lowercase item_group the backend variant rule reads, the display name, and
 *  the catalog SELLING price in centi (defaults the line's unit price; the
 *  server recompute stays authoritative on save). */
export type PickedSku = {
  itemCode: string;
  itemGroup: string;
  name: string;
  unitPriceCenti: number;
  category: MfgCategory;
};

export function MobileSkuPicker({
  initialCat,
  onPick,
  onClose,
}: {
  /* The line's current category seeds the sheet's default chip so a bedframe
     line opens pre-filtered to bedframes — but the operator can switch to
     "All" or any other chip, so it never BLOCKS selecting another category. */
  initialCat?: SkuPickerCat;
  onPick: (sku: PickedSku) => void;
  onClose: () => void;
}) {
  const seedCat: MfgCategory | "" =
    initialCat === "sofa" ? "SOFA" : initialCat === "bedframe" ? "BEDFRAME" : "";
  const [cat, setCat] = useState<MfgCategory | "">(seedCat);
  const [search, setSearch] = useState("");

  // The catalog read. Category "" omits the filter (shows all); search is a
  // server-side code/name match (GET /mfg-products?category=&search=).
  const productsQ = useMfgProducts({
    category: cat || undefined,
    search: search.trim() || undefined,
  });

  const rows = useMemo<MfgProductRow[]>(
    () => (productsQ.data ?? []).filter((p) => p.status !== "INACTIVE"),
    [productsQ.data],
  );

  return (
    <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="ey" style={{ color: "#a16a2e" }}>Catalog</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 2 }}>Pick a product</div>
          </div>
          <button className="sheet-x" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <div style={{ padding: "0 14px 10px", display: "flex", flexDirection: "column", gap: 9, flex: "none" }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search code or name"
              autoFocus
            />
          </div>
          <div className="chips">
            {CAT_CHIPS.map((c) => (
              <button
                key={c.value || "all"}
                className={`chip${cat === c.value ? " on" : ""}`}
                onClick={() => setCat(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="sheet-scroll" style={{ gap: 7 }}>
          {productsQ.isLoading ? (
            <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "28px 0" }}>Loading catalog{"…"}</div>
          ) : productsQ.isError ? (
            <div style={{ textAlign: "center", color: "#b23a3a", fontSize: 12, padding: "28px 0" }}>Couldn{"’"}t load the catalog. Pull down and try again.</div>
          ) : rows.length === 0 ? (
            <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "28px 0" }}>No products match{search.trim() ? ` "${search.trim()}"` : ""}.</div>
          ) : (
            rows.map((p) => {
              const priceSen = p.sell_price_sen ?? p.base_price_sen ?? 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onPick({
                      itemCode: p.code,
                      itemGroup: p.category.toLowerCase(),
                      name: p.name,
                      unitPriceCenti: p.sell_price_sen ?? 0,
                      category: p.category,
                    });
                    onClose();
                  }}
                  style={{
                    textAlign: "left", width: "100%", boxSizing: "border-box",
                    border: "1px solid rgba(34,31,32,.12)", borderRadius: 11, background: "#fff",
                    padding: "10px 12px", cursor: "pointer", fontFamily: "inherit",
                    display: "flex", alignItems: "center", gap: 10,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#11140f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    <span style={{ display: "block", fontSize: 10.5, color: "#767b6e", marginTop: 2 }}>
                      <span style={{ fontWeight: 700 }}>{p.code}</span> {"·"} {p.category}
                    </span>
                  </span>
                  <span className="money" style={{ flex: "none", fontSize: 12, fontWeight: 700, color: "#0c3f39" }}>
                    RM {fromSen(priceSen)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
