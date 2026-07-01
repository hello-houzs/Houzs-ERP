import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { api } from "../api/client";
import type { FormSchema } from "./MobileModuleForm";
import "./mobile.css";

// ---------------------------------------------------------------------------
// MobileModuleList — ONE generic, config-driven mobile list screen that backs
// the many simple SCM modules (Suppliers, Delivery Orders, Sales Invoices,
// GRN, Purchase Orders, Warehouse, Inventory, Drivers, Helpers, …). It is a
// deliberate 1:1 visual match of MobileSalesOrders (same header eyebrow + big
// title + optional action button, same search bar, same card list, same
// .hz-m scoping / tokens / .money / dm() date helper / loading-error-empty
// states / bottom-safe scroll). A parent renders any module by passing a
// ModuleConfig (see MODULE_CONFIGS below for ready-made ones).
// ---------------------------------------------------------------------------

/** A shorthand hint the caller can use to build `secondary`/`right` — kept for
 *  documentation; configs below use the function forms directly. */
export type Column = { key: string; label?: string };

/** A labelled row shown in the design-style card grid: [accessor, label].
 *  The accessor returns the already-formatted value string (money via rm(),
 *  dates via dm()); a blank/"—" result renders as an em-dash. */
export type FieldDef = [accessor: (row: any) => string, label: string];

/** A chip filter: a labelled button that filters rows via `match` and shows a
 *  live count. `key` is a stable id (also the "all"-sentinel when key === "all",
 *  which the render treats as "no filter"). */
export type ChipDef = { key: string; label: string; match: (row: any) => boolean };

/** A sort option for the sort control. */
export type SortDef = { key: string; label: string; cmp: (a: any, b: any) => number };

export type ModuleConfig = {
  /** Big title, e.g. "Suppliers". */
  title: string;
  /** Small uppercase eyebrow above the title, e.g. "Supply chain". */
  eyebrow?: string;
  /** Path relative to /api/scm, e.g. "/suppliers?limit=200". When `core` is
   *  true the path is relative to the core "/api" instead (e.g. "/api/users"). */
  endpoint: string;
  /** Hit the core /api client instead of the SCM authedFetch base. */
  core?: boolean;
  /** Key in the response object holding the array. Auto-detected if omitted. */
  listKey?: string;
  /** Main (bold) line, e.g. row => row.name. */
  primary: (row: any) => string;
  /** Muted sub line, e.g. row => `${row.code} · ${row.phone}`. */
  secondary?: (row: any) => string;
  /** Right-aligned value (money total or status). */
  right?: (row: any) => string;
  /** When true, `right` returns a *_centi value → rendered as RM x/100. */
  rightMoney?: boolean;
  /** Haystack for the search box; falls back to primary + secondary. */
  search?: (row: any) => string;

  // ── Design-style config (optional, backward compatible) ────────────────────
  /** Search box placeholder; falls back to `Search <title>`. */
  placeholder?: string;
  /** When present, each card renders the design template: title (primary) +
   *  status pill (pill) + a compact grid of these labelled field rows (so-k /
   *  so-v pairs). When absent, the card falls back to primary/secondary/right. */
  fields?: FieldDef[];
  /** The row's status/category text → the pill above the card grid. */
  pill?: (row: any) => string;
  /** Primary chip filter row (status/level/category) with live counts. */
  chips?: ChipDef[];
  /** Optional secondary chip filter (supplier / warehouse). */
  chips2?: ChipDef[];
  /** Sort options; the first is the default. */
  sorts?: SortDef[];

  /** When present, this module supports CREATE (+ New button) and — when the
   *  schema declares an updatePath — EDIT (from the detail screen). The parent
   *  (MobileApp) wires onNew/onEdit → MobileModuleForm with this schema. See
   *  FORM_SCHEMAS below for the ready-made ones. */
  form?: FormSchema;
};

const rm = (centi: number | null | undefined) =>
  ((Number(centi) || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dm = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(+dt)) return "—";
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};

/** Format a *_centi/_sen value as `RM x,xxx.00` for a field cell. Blank input
 *  (null / undefined / "") → "—" so an absent amount is not shown as RM 0.00. */
const rmField = (centi: number | null | undefined) =>
  centi == null || centi === ("" as unknown) ? "—" : `RM ${rm(centi)}`;

/** Read a value that may arrive camelCase (PostgREST driver / computed JS) or
 *  snake_case (raw). Returns the first defined of the candidates. */
const pick = (row: any, ...keys: string[]) => {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && v !== "") return v;
  }
  return undefined;
};

/** Case-insensitive equality against a value that may be null. */
const eq = (a: unknown, b: string) => String(a ?? "").trim().toLowerCase() === b.toLowerCase();

/** Humanize a raw status enum ("partially_received", "IN_STOCK") into a Title
 *  Case pill label that matches the PILL palette keys. */
const statusLabel = (raw: unknown): string => {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  return t
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
};

// Design PILL palette (ported 1:1 from the mobile prototype's PILL map). Keyed
// by the human label the `pill(row)` accessor returns; unknown → neutral grey.
const PILL: Record<string, [string, string]> = {
  Draft: ["#f4f6f3", "#767b6e"], Submitted: ["#e1efed", "#0c3f39"], Cancelled: ["#f8eaea", "#b23a3a"],
  Dispatched: ["#f6efd9", "#6e4d12"], Delivered: ["#e2f0e9", "#2f8a5b"], Signed: ["#e1efed", "#0c3f39"],
  Sent: ["#f6efd9", "#6e4d12"], "Partially Paid": ["#f6efd9", "#6e4d12"], Paid: ["#e2f0e9", "#2f8a5b"], Overdue: ["#f8eaea", "#b23a3a"],
  Open: ["#f6efd9", "#6e4d12"], "Partially Received": ["#f6efd9", "#6e4d12"], Received: ["#e2f0e9", "#2f8a5b"], Closed: ["#f4f6f3", "#767b6e"],
  Unpaid: ["#f6efd9", "#6e4d12"], Completed: ["#e2f0e9", "#2f8a5b"],
  "In stock": ["#e2f0e9", "#2f8a5b"], Shortage: ["#f8eaea", "#b23a3a"], "On PO": ["#f6efd9", "#6e4d12"], Low: ["#f6efd9", "#6e4d12"], Zero: ["#f8eaea", "#b23a3a"],
  Sofa: ["#e2f0e9", "#2f8a5b"], Mattress: ["#f3ece0", "#a16a2e"], Bedframe: ["#e1efed", "#0c3f39"], Accessory: ["#f4f6f3", "#767b6e"],
  Active: ["#e2f0e9", "#2f8a5b"], Invited: ["#f6efd9", "#6e4d12"], Inactive: ["#f4f6f3", "#767b6e"],
  "In-house": ["#e2f0e9", "#2f8a5b"], Outsource: ["#f3ece0", "#a16a2e"], Off: ["#f4f6f3", "#767b6e"],
};

function Pill({ label }: { label: string }) {
  const clean = (label ?? "").trim();
  if (!clean) return null;
  const [bg, fg] = PILL[clean] ?? ["#f4f6f3", "#767b6e"];
  return (
    <span className="spill" style={{ background: bg, color: fg }}>
      {clean}
    </span>
  );
}

/** Stock-level pill label from an on-hand qty (design: In stock / Low / Zero).
 *  Threshold mirrors the chip filters (<5 = Low, 0 = Zero). */
const stockLevel = (qty: unknown): string => {
  const q = Number(qty ?? 0);
  if (!Number.isFinite(q) || q <= 0) return "Zero";
  if (q < 5) return "Low";
  return "In stock";
};

/** MRP row state pill (design: In stock / Shortage / On PO), derived from the
 *  computed shortage / poOutstanding fields. Shortage wins, then incoming PO. */
const mrpState = (r: any): string => {
  const shortage = Number(pick(r, "shortage") ?? 0);
  const incoming = Number(pick(r, "poOutstanding", "po_outstanding") ?? 0);
  if (shortage > 0) return "Shortage";
  if (incoming > 0) return "On PO";
  return "In stock";
};

/** Invoice balance = total − paid, floored at 0, in centi. */
const balanceCenti = (r: any): number => {
  const total = Number(pick(r, "totalCenti", "total_centi", "localTotalCenti", "local_total_centi") ?? 0);
  const paid = Number(pick(r, "paidCenti", "paid_centi") ?? 0);
  return Math.max(0, (Number.isFinite(total) ? total : 0) - (Number.isFinite(paid) ? paid : 0));
};

/** Numeric-aware locale compare, mirroring the prototype's localeCompare with
 *  { numeric: true }. Used to keep sort keys terse in the configs. */
const byStr = (a: unknown, b: unknown) => String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
const byNum = (a: unknown, b: unknown) => (Number(b) || 0) - (Number(a) || 0);
const byDate = (a: unknown, b: unknown) => {
  const ta = a ? +new Date(String(a)) : 0;
  const tb = b ? +new Date(String(b)) : 0;
  return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
};

/** Pick the array out of a keyed response, or return it if already an array.
 *  With no listKey, take the first array-valued property of the object. */
function pickList(data: unknown, listKey?: string): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (listKey) return Array.isArray(obj[listKey]) ? (obj[listKey] as any[]) : [];
  for (const v of Object.values(obj)) if (Array.isArray(v)) return v as any[];
  return [];
}

const safe = (fn: ((row: any) => string) | undefined, row: any): string => {
  if (!fn) return "";
  try {
    return fn(row) ?? "";
  } catch {
    return "";
  }
};

/** Generic list screen. Cards call onOpen(row) when provided; the header shows
 *  a back button when onBack is provided. */
export function MobileModuleList({
  config,
  onBack,
  onOpen,
  onNew,
}: {
  config: ModuleConfig;
  onBack?: () => void;
  onOpen?: (row: any) => void;
  /** Wired by the parent when config.form is present — opens MobileModuleForm
   *  in create mode. The "+ New" header button calls this. */
  onNew?: () => void;
}) {
  const [q, setQ] = useState("");
  const [chip, setChip] = useState("all");
  const [chip2, setChip2] = useState("all");
  const [sortKey, setSortKey] = useState(config.sorts?.[0]?.key ?? "");

  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-module", config.core ? "core" : "scm", config.endpoint],
    queryFn: () => (config.core ? api.get<unknown>(config.endpoint) : authedFetch<unknown>(config.endpoint)),
    staleTime: 30_000,
  });

  const all = useMemo(() => pickList(data, config.listKey), [data, config.listKey]);

  // Search + chip filters (real rows, client-side — mirrors the prototype's
  // renderList: chip, then chip2, then free-text search).
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const chipDef = chip !== "all" ? config.chips?.find((c) => c.key === chip) : undefined;
    const chip2Def = chip2 !== "all" ? config.chips2?.find((c) => c.key === chip2) : undefined;
    let out = all.filter((r) => {
      if (chipDef && !safeMatch(chipDef.match, r)) return false;
      if (chip2Def && !safeMatch(chip2Def.match, r)) return false;
      if (needle) {
        const hay = config.search ? safe(config.search, r) : `${safe(config.primary, r)} ${safe(config.secondary, r)}`;
        if (!hay.toLowerCase().includes(needle)) return false;
      }
      return true;
    });
    const sortDef = config.sorts?.find((s) => s.key === sortKey);
    if (sortDef) out = out.slice().sort((a, b) => { try { return sortDef.cmp(a, b); } catch { return 0; } });
    return out;
  }, [all, q, chip, chip2, sortKey, config]);

  const useFields = !!config.fields?.length;

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          {onBack ? (
            <span onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12.5, fontWeight: 600, color: "#16695f", cursor: "pointer" }}>
              <span style={{ fontSize: 17, lineHeight: 1 }}>‹</span> Menu
            </span>
          ) : (
            <span />
          )}
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {config.eyebrow && <span className="ey" style={{ color: "#a16a2e" }}>{config.eyebrow}</span>}
            {onNew && (
              // Render whenever the parent wires onNew — a module with a `form`
              // opens MobileModuleForm; a doc module (DO/SI/GRN/PO) opens the
              // convert wizard. Both go through the same "+ New" affordance.
              <button onClick={onNew} className="tinybtn" style={{ background: "#16695f", borderColor: "#16695f", color: "#fff" }}>+ New</button>
            )}
          </span>
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#11140f", marginBottom: 11 }}>{config.title}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, background: "#f4f6f3", border: "1px solid #d6d9d2", borderRadius: 10, padding: "8px 11px" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={config.placeholder ?? `Search ${config.title.toLowerCase()}`} style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", fontFamily: "inherit", fontSize: 13, color: "#11140f" }} />
          </div>
          {config.sorts && config.sorts.length > 0 && (
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
              aria-label="Sort"
              className="cal-sel"
              style={{ flex: "none", width: "auto", fontSize: 12, borderRadius: 10, padding: "0 8px", height: 38 }}
            >
              {config.sorts.map((sdef) => (
                <option key={sdef.key} value={sdef.key}>Sort: {sdef.label}</option>
              ))}
            </select>
          )}
        </div>

        {config.chips && config.chips.length > 0 && (
          <div style={{ display: "flex", gap: 7, overflowX: "auto", marginTop: 10, paddingBottom: 2 }}>
            {config.chips.map((c) => {
              const on = chip === c.key;
              const count = c.key === "all" ? all.length : all.filter((r) => safeMatch(c.match, r)).length;
              return (
                <button key={c.key} onClick={() => setChip(c.key)} className={on ? "sochip on" : "sochip"}>
                  {c.label} (<span className="cnt">{count}</span>)
                </button>
              );
            })}
          </div>
        )}
        {config.chips2 && config.chips2.length > 0 && (
          <div style={{ display: "flex", gap: 7, overflowX: "auto", marginTop: 8, paddingBottom: 2 }}>
            {config.chips2.map((c) => (
              <button key={c.key} onClick={() => setChip2(c.key)} className={chip2 === c.key ? "sochip on" : "sochip"}>{c.label}</button>
            ))}
          </div>
        )}
      </header>

      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 120 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", fontSize: 11.5, color: "var(--muted)", margin: "0 2px 11px" }}>
          <span><b style={{ color: "var(--ink)" }}>{rows.length}</b> {rows.length === 1 ? "record" : "records"}</span>
        </div>

        {isLoading && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {!!error && <div style={{ textAlign: "center", color: "#b23a3a", fontSize: 12, padding: "26px 0" }}>Couldn't load {config.title.toLowerCase()}. Pull to retry.</div>}
        {!isLoading && !error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            {rows.map((r, i) => {
              const clickable = !!onOpen;
              const key = (r.id as string) ?? (r.doc_no as string) ?? i;
              if (useFields) {
                const title = safe(config.primary, r) || "—";
                const pillLabel = config.pill ? safe(config.pill, r) : "";
                const cancelled = eq(pillLabel, "Cancelled");
                return (
                  <div
                    key={key}
                    onClick={clickable ? () => onOpen!(r) : undefined}
                    className={cancelled ? "so-row cancelled" : "so-row"}
                    style={clickable ? undefined : { cursor: "default" }}
                  >
                    <div className="so-row-head">
                      <span className="so-row-name">{title}</span>
                      {pillLabel ? <Pill label={pillLabel} /> : null}
                    </div>
                    <div className="so-grid">
                      {config.fields!.map(([accessor, label]) => (
                        <div key={label} style={{ display: "contents" }}>
                          <span className="so-k">{label}</span>
                          <span className="so-v money">{safe(accessor, r) || "—"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }
              // Fallback: legacy primary / secondary / right module (no fields[]).
              // Rendered with the same design .so-row markup — the right value
              // becomes a value pill, secondary a single so-k / so-v pair.
              const primary = safe(config.primary, r) || "—";
              const secondary = safe(config.secondary, r);
              const rightRaw = config.right ? config.right(r) : "";
              const rightText = config.rightMoney ? `RM ${rm(rightRaw as unknown as number)}` : rightRaw;
              return (
                <div
                  key={key}
                  onClick={clickable ? () => onOpen!(r) : undefined}
                  className="so-row"
                  style={clickable ? undefined : { cursor: "default" }}
                >
                  <div className="so-row-head">
                    <span className="so-row-name">{primary}</span>
                    {rightText && <span className="so-v money" style={{ fontWeight: 800 }}>{rightText}</span>}
                  </div>
                  {secondary && (
                    <div className="so-grid">
                      <span className="so-k">Detail</span>
                      <span className="so-v money">{secondary}</span>
                    </div>
                  )}
                </div>
              );
            })}
            {!rows.length && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "26px 0" }}>No {config.title.toLowerCase()} to show.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

const safeMatch = (fn: ((row: any) => boolean) | undefined, row: any): boolean => {
  if (!fn) return true;
  try { return !!fn(row); } catch { return false; }
};

// ---------------------------------------------------------------------------
// MODULE_CONFIGS — ready-made configs for the simple SCM modules. Field names +
// response array keys were read from backend/src/scm/routes/*.ts (the SELECT
// column lists and the c.json({ … }) response wrappers), not guessed.
// ---------------------------------------------------------------------------

const join = (...parts: Array<string | null | undefined>) =>
  parts.map((p) => (p == null ? "" : String(p)).trim()).filter(Boolean).join(" · ");

// ---------------------------------------------------------------------------
// FORM_SCHEMAS — CREATE / EDIT form definitions, one per module that supports
// writes. Field keys are the camelCase body keys the backend routes accept
// (read from backend/src/scm/routes/*.ts + backend/src/routes/*.ts), NOT the
// snake_case DB columns. Money fields carry a moneyScale (100 = sen). Only
// fields the endpoints actually accept are exposed. Exported so MobileApp can
// reference a schema directly when wiring onNew/onEdit.
// ---------------------------------------------------------------------------

/* suppliers — POST /suppliers (code+name required), PATCH /suppliers/:id.
   Response wraps the record as { supplier: {...} }; id = supplier.id. Rich
   AutoCount master; the mobile form exposes the everyday subset. credit_limit
   is stored in SEN (credit_limit_sen) → money scale 100. Bindings (assigned
   SKUs + per-category price matrix) are a separate endpoint → not in this
   flat form. */
export const FORM_SUPPLIERS: FormSchema = {
  title: "Supplier",
  eyebrow: "Procurement",
  base: "scm",
  createPath: "/suppliers",
  updatePath: (id) => `/suppliers/${encodeURIComponent(id)}`,
  idKey: "id",
  responseIdKeys: ["id"],
  fields: [
    { key: "code", label: "Code", type: "text", required: true, placeholder: "e.g. SUP-001" },
    { key: "name", label: "Name", type: "text", required: true, placeholder: "Company name" },
    { key: "contactPerson", label: "Contact Person", type: "text" },
    { key: "phone", label: "Phone", type: "tel", placeholder: "01X-XXX XXXX" },
    { key: "mobile", label: "Mobile", type: "tel" },
    { key: "whatsappNumber", label: "WhatsApp", type: "tel" },
    { key: "email", label: "Email", type: "email", placeholder: "supplier@example.com" },
    { key: "address", label: "Address", type: "textarea" },
    { key: "state", label: "State", type: "text" },
    { key: "postcode", label: "Postcode", type: "text" },
    { key: "area", label: "Area", type: "text" },
    { key: "country", label: "Country", type: "text", placeholder: "Malaysia" },
    { key: "paymentTerms", label: "Payment Terms", type: "text", placeholder: "e.g. Net 30" },
    { key: "status", label: "Status", type: "select", options: [
      { value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }, { value: "BLOCKED", label: "Blocked" },
    ], placeholder: "Active" },
    { key: "currency", label: "Currency", type: "select", options: [
      { value: "MYR", label: "MYR" }, { value: "RMB", label: "RMB" }, { value: "USD", label: "USD" }, { value: "SGD", label: "SGD" },
    ], placeholder: "MYR" },
    { key: "creditLimitSen", label: "Credit Limit (RM)", type: "money", moneyScale: 100 },
    { key: "businessRegNo", label: "Business Reg No", type: "text" },
    { key: "tinNumber", label: "TIN Number", type: "text" },
    { key: "website", label: "Website", type: "text" },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
};

/* drivers — POST /drivers (driverCode+name+phone required), PATCH /drivers/:id.
   Response wraps as { driver: {...} }; id = driver.id. */
export const FORM_DRIVERS: FormSchema = {
  title: "Driver",
  eyebrow: "Transportation",
  base: "scm",
  createPath: "/drivers",
  updatePath: (id) => `/drivers/${encodeURIComponent(id)}`,
  idKey: "id",
  fields: [
    { key: "driverCode", label: "Driver Code", type: "text", required: true, placeholder: "e.g. DRV-01" },
    { key: "name", label: "Name", type: "text", required: true },
    { key: "phone", label: "Phone", type: "tel", required: true, placeholder: "01X-XXX XXXX" },
    { key: "icNumber", label: "IC Number", type: "text" },
    { key: "vehicle", label: "Vehicle", type: "text", placeholder: "e.g. Lorry 3-tonne" },
    { key: "inHouse", label: "Fleet", type: "select", options: [
      { value: "true", label: "In-house" }, { value: "false", label: "Outsource" },
    ], placeholder: "In-house" },
    { key: "active", label: "Active", type: "select", options: [
      { value: "true", label: "Active" }, { value: "false", label: "Inactive" },
    ], placeholder: "Active" },
  ],
};

/* fleet — POST /lorries (plate required, type enum), PATCH /lorries/:id.
   Response wraps as { lorry: {...} }; id = lorry.id. capacityM3 / capacityKg
   are numeric(.,.) → plain numbers (NOT money). */
export const FORM_FLEET: FormSchema = {
  title: "Lorry",
  eyebrow: "Transportation",
  base: "scm",
  createPath: "/lorries",
  updatePath: (id) => `/lorries/${encodeURIComponent(id)}`,
  idKey: "id",
  fields: [
    { key: "plate", label: "Plate", type: "text", required: true, placeholder: "e.g. VBA 1234" },
    { key: "type", label: "Type", type: "select", options: [
      { value: "LORRY_10FT", label: "Lorry 10ft" }, { value: "LORRY_14FT", label: "Lorry 14ft" },
      { value: "LORRY_17FT", label: "Lorry 17ft" }, { value: "LORRY_21FT", label: "Lorry 21ft" },
      { value: "VAN", label: "Van" }, { value: "OUTSOURCE", label: "Outsource" }, { value: "OTHER", label: "Other" },
    ], placeholder: "Other" },
    { key: "isInternal", label: "Fleet", type: "select", options: [
      { value: "true", label: "In-house" }, { value: "false", label: "Outsource" },
    ], placeholder: "In-house" },
    { key: "capacityM3", label: "Capacity (m3)", type: "number" },
    { key: "capacityKg", label: "Capacity (kg)", type: "number" },
    { key: "notes", label: "Notes", type: "textarea" },
    { key: "active", label: "Active", type: "select", options: [
      { value: "true", label: "Active" }, { value: "false", label: "Inactive" },
    ], placeholder: "Active" },
  ],
};

/* warehouse — CREATE ONLY. There is no base POST /warehouse; a warehouse row
   has no per-record edit route. The write surface is racks: POST
   /warehouse/racks (warehouseId + rack label required). We pre-fill warehouseId
   from the tapped warehouse row when the parent seeds `initial`, else the
   operator types it. No updatePath → the detail screen shows no Edit button. */
export const FORM_WAREHOUSE: FormSchema = {
  title: "Rack",
  eyebrow: "Storage",
  base: "scm",
  createPath: "/warehouse/racks",
  idKey: "id",
  responseIdKeys: ["id"],
  fields: [
    { key: "warehouseId", label: "Warehouse ID", type: "text", required: true, hint: "The warehouse this rack belongs to." },
    { key: "rack", label: "Rack Label", type: "text", required: true, placeholder: "e.g. Rack A1" },
    { key: "position", label: "Position", type: "text" },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
};

/* departments — CORE. POST /api/departments (name required), PATCH
   /api/departments/:id. Create returns the record flat ({ id, name, ... });
   PATCH returns { ok:true } so edit keeps the row's own id. color = 6-char hex
   (no '#'); sort_order = integer. */
export const FORM_DEPARTMENTS: FormSchema = {
  title: "Department",
  eyebrow: "Team",
  base: "core",
  createPath: "/api/departments",
  updatePath: (id) => `/api/departments/${encodeURIComponent(id)}`,
  idKey: "id",
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "description", label: "Description", type: "textarea" },
    { key: "color", label: "Color (hex)", type: "text", placeholder: "64748b", hint: "6-character hex, no #." },
    { key: "sort_order", label: "Sort Order", type: "number", integer: true },
  ],
};

/* positions — CORE. POST /api/positions (name required), PATCH
   /api/positions/:id. Create returns { id, slug, name }; PATCH returns
   { ok:true }. department_id is a real record → runtime select from
   GET /api/departments. level / sort_order = integers. */
export const FORM_POSITIONS: FormSchema = {
  title: "Position",
  eyebrow: "Team",
  base: "core",
  createPath: "/api/positions",
  updatePath: (id) => `/api/positions/${encodeURIComponent(id)}`,
  idKey: "id",
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "department_id", label: "Department", type: "select", placeholder: "Unassigned",
      optionsSource: { base: "core", path: "/api/departments", listKey: "departments", value: (r) => r.id, label: (r) => r.name } },
    { key: "level", label: "Level", type: "number", integer: true, hint: "Lower = more senior. Default 100." },
    { key: "sort_order", label: "Sort Order", type: "number", integer: true },
  ],
};

/* members — CORE. CREATE = INVITE: POST /api/users/invite (email + role_id
   required; optional name / department_id / position_id / phone). Returns
   { token, ... } or { active, email } — no user id, so onSaved gets "".
   EDIT: PATCH /api/users/:id (role_id / status / name / phone / department_id /
   position_id / email). role_id, department_id, position_id are real records →
   runtime selects. status enum on the routes is active|disabled. Note: invite
   requires users.manage (permission-gated — a 403 surfaces inline). */
export const FORM_MEMBERS: FormSchema = {
  title: "Member",
  eyebrow: "Team",
  base: "core",
  createPath: "/api/users/invite",
  updatePath: (id) => `/api/users/${encodeURIComponent(id)}`,
  idKey: "id",
  responseIdKeys: ["id"],
  fields: [
    { key: "email", label: "Email", type: "email", required: true, placeholder: "member@example.com" },
    { key: "name", label: "Name", type: "text" },
    { key: "role_id", label: "Role", type: "select", required: true, placeholder: "Select role…",
      optionsSource: { base: "core", path: "/api/roles", listKey: "roles", value: (r) => r.id, label: (r) => r.name } },
    { key: "department_id", label: "Department", type: "select", placeholder: "Unassigned",
      optionsSource: { base: "core", path: "/api/departments", listKey: "departments", value: (r) => r.id, label: (r) => r.name } },
    { key: "position_id", label: "Position", type: "select", placeholder: "Unassigned",
      optionsSource: { base: "core", path: "/api/positions", listKey: "positions", value: (r) => r.id, label: (r) => `${r.name}${r.department_name ? ` (${r.department_name})` : ""}` } },
    { key: "phone", label: "Phone", type: "tel" },
  ],
};

/* members EDIT — PATCH /api/users/:id. The invite create-form above can't carry
   `status` (invite has no status field), so edit mode swaps in a status select.
   MobileApp uses FORM_MEMBERS_EDIT for the Edit button and FORM_MEMBERS for
   + New. Shares the same base/paths/idKey. */
export const FORM_MEMBERS_EDIT: FormSchema = {
  ...FORM_MEMBERS,
  fields: [
    { key: "name", label: "Name", type: "text" },
    { key: "email", label: "Email", type: "email" },
    { key: "role_id", label: "Role", type: "select", placeholder: "Select role…",
      optionsSource: { base: "core", path: "/api/roles", listKey: "roles", value: (r) => r.id, label: (r) => r.name } },
    { key: "department_id", label: "Department", type: "select", placeholder: "Unassigned",
      optionsSource: { base: "core", path: "/api/departments", listKey: "departments", value: (r) => r.id, label: (r) => r.name } },
    { key: "position_id", label: "Position", type: "select", placeholder: "Unassigned",
      optionsSource: { base: "core", path: "/api/positions", listKey: "positions", value: (r) => r.id, label: (r) => `${r.name}${r.department_name ? ` (${r.department_name})` : ""}` } },
    { key: "phone", label: "Phone", type: "tel" },
    { key: "status", label: "Status", type: "select", options: [
      { value: "active", label: "Active" }, { value: "disabled", label: "Disabled" },
    ], placeholder: "Active" },
  ],
};

export const MODULE_CONFIGS: Record<string, ModuleConfig> = {
  // suppliers.get('/') → { suppliers: [...] }; cols: code, name, contact_person,
  // phone, mobile, whatsapp_number, derived_category, status…
  // Design m-suppliers: Code/Contact/Phone/Supplies + category pill. "Supplies"
  // has NO column (it's a bindings join) → OMITTED.
  suppliers: {
    title: "Suppliers",
    eyebrow: "Procurement",
    placeholder: "Search name · code · contact",
    endpoint: "/suppliers?limit=200",
    listKey: "suppliers",
    primary: (r) => r.name,
    secondary: (r) => join(r.code, r.phone || r.mobile),
    right: (r) => r.status ?? "",
    search: (r) => join(r.name, r.code, r.phone, r.contact_person, r.email),
    pill: (r) => pick(r, "derivedCategory", "derived_category", "category") ?? "",
    fields: [
      [(r) => pick(r, "code") ?? "—", "Code"],
      [(r) => pick(r, "contactPerson", "contact_person", "attention") ?? "—", "Contact"],
      [(r) => pick(r, "phone", "mobile", "whatsappNumber", "whatsapp_number") ?? "—", "Phone"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_SUPPLIERS,
  },

  // delivery-orders-mfg.get('/') → { deliveryOrders: [...] }; header cols:
  // do_number, debtor_name, status, do_date, local_total_centi…
  // Design m-do: Customer/DO No/Date/Driver/Items/Value + status pill. Real cols:
  // debtor_name, do_number, do_date, driver_name, line_count, local_total_centi,
  // status. All present → all fields bound.
  "delivery-orders-mfg": {
    title: "Delivery Orders",
    eyebrow: "Logistics",
    placeholder: "Search DO · customer",
    endpoint: "/delivery-orders-mfg?limit=500&fields=minimal",
    listKey: "deliveryOrders",
    primary: (r) => r.debtor_name,
    secondary: (r) => join(r.do_number, r.status, dm(r.do_date)),
    right: (r) => r.local_total_centi,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.do_number, r.so_doc_no, r.ref),
    pill: (r) => statusLabel(pick(r, "status")),
    fields: [
      [(r) => pick(r, "doNumber", "do_number") ?? "—", "DO No"],
      [(r) => dm(pick(r, "doDate", "do_date")), "Date"],
      [(r) => pick(r, "driverName", "driver_name") ?? "—", "Driver"],
      [(r) => { const n = pick(r, "lineCount", "line_count"); return n == null ? "—" : String(n); }, "Items"],
      [(r) => rmField(pick(r, "localTotalCenti", "local_total_centi")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "Dispatched", label: "Dispatched", match: (r) => eq(pick(r, "status"), "dispatched") },
      { key: "Delivered", label: "Delivered", match: (r) => eq(pick(r, "status"), "delivered") },
      { key: "Cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [
      { key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "doDate", "do_date"), pick(b, "doDate", "do_date")) },
      { key: "cust", label: "Customer", cmp: (a, b) => byStr(a.debtor_name, b.debtor_name) },
    ],
  },

  // sales-invoices.get('/') → { salesInvoices: [...] }; header cols:
  // invoice_number, debtor_name, invoice_date, total_centi, status…
  // Design m-si: Inv No/Date/Due/Amount/Balance + status pill. Real cols:
  // invoice_number, invoice_date, due_date, total_centi, paid_centi, status.
  // Balance is computed total − paid.
  "sales-invoices": {
    title: "Sales Invoices",
    eyebrow: "Finance",
    placeholder: "Search invoice · customer",
    endpoint: "/sales-invoices?limit=500&fields=minimal",
    listKey: "salesInvoices",
    primary: (r) => r.debtor_name,
    secondary: (r) => join(r.invoice_number, r.status, dm(r.invoice_date)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.invoice_number, r.so_doc_no, r.ref),
    pill: (r) => statusLabel(pick(r, "status")),
    fields: [
      [(r) => pick(r, "invoiceNumber", "invoice_number") ?? "—", "Inv No"],
      [(r) => dm(pick(r, "invoiceDate", "invoice_date")), "Date"],
      [(r) => dm(pick(r, "dueDate", "due_date")), "Due"],
      [(r) => rmField(pick(r, "totalCenti", "total_centi", "localTotalCenti", "local_total_centi")), "Amount"],
      [(r) => rmField(balanceCenti(r)), "Balance"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "sent", label: "Sent", match: (r) => eq(pick(r, "status"), "sent") },
      { key: "partial", label: "Part. paid", match: (r) => /partial/i.test(String(pick(r, "status") ?? "")) },
      { key: "paid", label: "Paid", match: (r) => eq(pick(r, "status"), "paid") },
      { key: "overdue", label: "Overdue", match: (r) => eq(pick(r, "status"), "overdue") },
    ],
    sorts: [
      { key: "due", label: "Due date", cmp: (a, b) => byDate(pick(a, "dueDate", "due_date"), pick(b, "dueDate", "due_date")) },
      { key: "amount", label: "Amount", cmp: (a, b) => byNum(pick(a, "totalCenti", "total_centi"), pick(b, "totalCenti", "total_centi")) },
    ],
  },

  // grns.get('/') → { grns: [...] }; header cols: grn_number, received_at,
  // status, total_centi + nested supplier:{code,name}.
  // Design m-gr: GR No/PO/Date/Items + status pill. Real cols: grn_number,
  // nested purchase_order.po_number, received_at, status. Items count has NO
  // column on the list row (items are a separate table) → OMITTED.
  grns: {
    title: "Goods Receipt",
    eyebrow: "Procurement",
    placeholder: "Search GR · supplier · PO",
    endpoint: "/grns?limit=500&fields=minimal",
    listKey: "grns",
    primary: (r) => r.supplier?.name || r.grn_number,
    secondary: (r) => join(r.grn_number, r.status, dm(r.received_at)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.grn_number, r.supplier?.name, r.supplier?.code, r.delivery_note_ref),
    pill: (r) => statusLabel(pick(r, "status")),
    fields: [
      [(r) => pick(r, "grnNumber", "grn_number") ?? "—", "GR No"],
      [(r) => r.purchase_order?.po_number ?? r.purchaseOrder?.poNumber ?? "—", "PO"],
      [(r) => dm(pick(r, "receivedAt", "received_at")), "Date"],
      [(r) => rmField(pick(r, "totalCenti", "total_centi")), "Value"],
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "receivedAt", "received_at"), pick(b, "receivedAt", "received_at")) }],
  },

  // mfg-purchase-orders.get('/') → { purchaseOrders: [...] }; header cols:
  // po_number, status, po_date, total_centi + nested supplier:{code,name}.
  // Design m-po: Supplier/PO No/Date/Expected/Value + status pill. Real cols:
  // po_number, po_date, expected_at, total_centi, status, nested supplier.name.
  "mfg-purchase-orders": {
    title: "Purchase Orders",
    eyebrow: "Procurement",
    placeholder: "Search PO · supplier",
    endpoint: "/mfg-purchase-orders?limit=500&fields=minimal",
    listKey: "purchaseOrders",
    primary: (r) => r.supplier?.name || r.po_number,
    secondary: (r) => join(r.po_number, r.status, dm(r.po_date)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.po_number, r.supplier?.name, r.supplier?.code),
    pill: (r) => statusLabel(pick(r, "status")),
    fields: [
      [(r) => pick(r, "poNumber", "po_number") ?? "—", "PO No"],
      [(r) => dm(pick(r, "poDate", "po_date")), "Date"],
      [(r) => dm(pick(r, "expectedAt", "expected_at")), "Expected"],
      [(r) => rmField(pick(r, "totalCenti", "total_centi")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "open", label: "Open", match: (r) => eq(pick(r, "status"), "open") },
      { key: "partial", label: "Part. recv", match: (r) => /partial/i.test(String(pick(r, "status") ?? "")) },
      { key: "received", label: "Received", match: (r) => eq(pick(r, "status"), "received") },
      { key: "cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [
      { key: "exp", label: "Expected", cmp: (a, b) => byDate(pick(a, "expectedAt", "expected_at"), pick(b, "expectedAt", "expected_at")) },
      { key: "total", label: "Value", cmp: (a, b) => byNum(pick(a, "totalCenti", "total_centi"), pick(b, "totalCenti", "total_centi")) },
    ],
  },

  // warehouse.get('/') → { racks, warehouses }; warehouses row = {id,code,name}
  // ONLY. Design m-warehouse wants Code/State/Items/Utilisation — State, Items
  // and Utilisation have NO per-warehouse column → OMITTED; only Code is bound.
  // Pill = the warehouse code (design pillKey:'code').
  warehouse: {
    title: "Warehouse",
    eyebrow: "Storage",
    placeholder: "Search name · code",
    endpoint: "/warehouse",
    listKey: "warehouses",
    primary: (r) => r.name,
    secondary: (r) => join(r.code),
    search: (r) => join(r.name, r.code),
    pill: (r) => pick(r, "code") ?? "",
    fields: [
      [(r) => pick(r, "code") ?? "—", "Code"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_WAREHOUSE,
  },

  // inventory.get('/')?showAll=true → { balances, warehouses }; balances cols
  // (v_inventory_all_skus): product_code, product_name, category, qty,
  // warehouse_name, value_sen…
  // Design m-inventory: SKU/Warehouse/On hand/Reserved + stock-level pill. Real
  // v_inventory_all_skus cols: product_code, product_name, warehouse_code/_name,
  // qty, category. Reserved has NO column on this view → OMITTED. Level pill
  // (In stock / Low / Zero) is computed client-side from qty.
  inventory: {
    title: "Inventory",
    eyebrow: "Storage",
    placeholder: "Search product · SKU",
    endpoint: "/inventory?showAll=true",
    listKey: "balances",
    primary: (r) => r.product_name || r.product_code,
    secondary: (r) => join(r.product_code, r.category, r.warehouse_name),
    right: (r) => (r.qty == null ? "" : `${r.qty}`),
    search: (r) => join(r.product_name, r.product_code, r.category, r.warehouse_name),
    pill: (r) => stockLevel(pick(r, "qty")),
    fields: [
      [(r) => pick(r, "productCode", "product_code") ?? "—", "SKU"],
      [(r) => pick(r, "warehouseCode", "warehouse_code", "warehouseName", "warehouse_name") ?? "—", "Warehouse"],
      [(r) => { const n = pick(r, "qty"); return n == null ? "—" : String(n); }, "On hand"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "in", label: "In stock", match: (r) => Number(pick(r, "qty") ?? 0) >= 5 },
      { key: "low", label: "Low", match: (r) => { const q = Number(pick(r, "qty") ?? 0); return q > 0 && q < 5; } },
      { key: "zero", label: "Zero", match: (r) => Number(pick(r, "qty") ?? 0) <= 0 },
    ],
    sorts: [
      { key: "name", label: "Name", cmp: (a, b) => byStr(a.product_name, b.product_name) },
      { key: "onhand", label: "On hand", cmp: (a, b) => byNum(pick(a, "qty"), pick(b, "qty")) },
    ],
  },

  // drivers.get('/') → { drivers: [...] }; cols: driver_code, name, phone,
  // vehicle, in_house, active…
  // Design m-drivers: Phone/Lorry/Trips/Zone + status. Real cols: driver_code,
  // name, phone, vehicle, in_house, active. Lorry, Trips-today and Zone have NO
  // column (drivers are not linked to lorries/trips) → OMITTED; Phone + Vehicle
  // bound. Pill = In-house / Outsource (design "status").
  drivers: {
    title: "Drivers",
    eyebrow: "Transportation",
    placeholder: "Search driver · phone",
    endpoint: "/drivers",
    listKey: "drivers",
    primary: (r) => r.name,
    secondary: (r) => join(r.driver_code, r.phone, r.vehicle),
    right: (r) => (r.in_house ? "In-house" : "Outsource"),
    search: (r) => join(r.name, r.driver_code, r.phone, r.vehicle),
    pill: (r) => (pick(r, "inHouse", "in_house") ? "In-house" : "Outsource"),
    fields: [
      [(r) => pick(r, "phone") ?? "—", "Phone"],
      [(r) => pick(r, "driverCode", "driver_code") ?? "—", "Code"],
      [(r) => pick(r, "vehicle") ?? "—", "Vehicle"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_DRIVERS,
  },

  // helpers.get('/') → { helpers: [...] }; cols: helper_code, name, contact,
  // in_house, active… (note: `contact`, not `phone`).
  // Not in the design module map; mirror the drivers template. Real cols:
  // helper_code, name, contact (note: `contact`, not `phone`), in_house.
  helpers: {
    title: "Helpers",
    eyebrow: "Transportation",
    placeholder: "Search helper · contact",
    endpoint: "/helpers",
    listKey: "helpers",
    primary: (r) => r.name,
    secondary: (r) => join(r.helper_code, r.contact),
    right: (r) => (r.in_house ? "In-house" : "Outsource"),
    search: (r) => join(r.name, r.helper_code, r.contact),
    pill: (r) => (pick(r, "inHouse", "in_house") ? "In-house" : "Outsource"),
    fields: [
      [(r) => pick(r, "contact") ?? "—", "Contact"],
      [(r) => pick(r, "helperCode", "helper_code") ?? "—", "Code"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
  },

  // CORE api (not SCM): GET /api/users → { users: [...] }; cols name, email,
  // phone, role_name, department_name, position_name, status.
  // Design m-members: Email/Position/Department/Role + status pill. Real cols:
  // name, email, position_name, department_name, role_name, status.
  members: {
    title: "Members",
    eyebrow: "Team",
    placeholder: "Search name · email",
    core: true,
    endpoint: "/api/users",
    listKey: "users",
    primary: (r) => r.name || r.email,
    secondary: (r) => join(r.position_name, r.department_name, r.email),
    right: (r) => r.status ?? "",
    search: (r) => join(r.name, r.email, r.phone, r.position_name, r.department_name, r.role_name),
    pill: (r) => statusLabel(pick(r, "status")),
    fields: [
      [(r) => pick(r, "email") ?? "—", "Email"],
      [(r) => pick(r, "positionName", "position_name") ?? "—", "Position"],
      [(r) => pick(r, "departmentName", "department_name") ?? "—", "Department"],
      [(r) => pick(r, "roleName", "role_name") ?? "—", "Role"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "active", label: "Active", match: (r) => eq(pick(r, "status"), "active") },
      { key: "invited", label: "Invited", match: (r) => eq(pick(r, "status"), "invited") },
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_MEMBERS,
  },

  // CORE api: GET /api/positions → { positions: [...] }; cols id, name,
  // department_id (+ department name where joined).
  // Design m-positions: Department/Members/Key access + department pill. Real
  // cols: name, department_name, member_count. "Key access" lives in a separate
  // /positions/:id/page-access endpoint → OMITTED. Pill = department name.
  positions: {
    title: "Positions",
    eyebrow: "Team",
    placeholder: "Search position · department",
    core: true,
    endpoint: "/api/positions",
    listKey: "positions",
    primary: (r) => r.name,
    secondary: (r) => join(r.department_name, r.division),
    search: (r) => join(r.name, r.department_name),
    pill: (r) => pick(r, "departmentName", "department_name") ?? "",
    fields: [
      [(r) => pick(r, "departmentName", "department_name") ?? "—", "Department"],
      [(r) => { const n = pick(r, "memberCount", "member_count"); return n == null ? "—" : String(n); }, "Members"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_POSITIONS,
  },

  // CORE api: GET /api/departments → { departments: [...] }; cols id, name, color.
  // Design m-departments: Head/Members/Positions (no pill). Real cols: name,
  // member_count, color. Head and Positions count have NO column → OMITTED;
  // only Members bound.
  departments: {
    title: "Departments",
    eyebrow: "Team",
    placeholder: "Search department",
    core: true,
    endpoint: "/api/departments",
    listKey: "departments",
    primary: (r) => r.name,
    secondary: (r) => join(r.division),
    search: (r) => join(r.name),
    fields: [
      [(r) => { const n = pick(r, "memberCount", "member_count"); return n == null ? "—" : String(n); }, "Members"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_DEPARTMENTS,
  },

  // delivery-returns.get('/') → { deliveryReturns: [...] }; cols return_number,
  // do_doc_no, debtor_name, return_date, status, refund_centi.
  // Design m-pr (Sales Returns): Return No/Date/Reason/Value + status pill. Real
  // cols: return_number, return_date, reason, refund_centi, status. All present.
  "delivery-returns": {
    title: "Sales Returns",
    eyebrow: "Finance",
    placeholder: "Search return · customer",
    endpoint: "/delivery-returns?limit=500&fields=minimal",
    listKey: "deliveryReturns",
    primary: (r) => r.debtor_name || r.return_number,
    secondary: (r) => join(r.return_number, r.status, dm(r.return_date)),
    right: (r) => r.refund_centi,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.return_number, r.do_doc_no),
    pill: (r) => statusLabel(pick(r, "status")),
    fields: [
      [(r) => pick(r, "returnNumber", "return_number") ?? "—", "Return No"],
      [(r) => dm(pick(r, "returnDate", "return_date")), "Date"],
      [(r) => pick(r, "reason") ?? "—", "Reason"],
      [(r) => rmField(pick(r, "refundCenti", "refund_centi")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "open", label: "Open", match: (r) => eq(pick(r, "status"), "open") },
      { key: "completed", label: "Completed", match: (r) => eq(pick(r, "status"), "completed") },
      { key: "cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "returnDate", "return_date"), pick(b, "returnDate", "return_date")) }],
  },

  // purchase-invoices.get('/') → { purchaseInvoices: [...] }; cols invoice_number,
  // invoice_date, status, total_centi + nested supplier:{code,name}.
  // Design m-pi: PI No/Date/Due/Amount + status pill. Real cols: invoice_number,
  // invoice_date, due_date, total_centi, status, nested supplier.name.
  "purchase-invoices": {
    title: "Purchase Invoices",
    eyebrow: "Procurement",
    placeholder: "Search PI · supplier",
    endpoint: "/purchase-invoices?limit=500&fields=minimal",
    listKey: "purchaseInvoices",
    primary: (r) => r.supplier?.name || r.invoice_number,
    secondary: (r) => join(r.invoice_number, r.status, dm(r.invoice_date)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.invoice_number, r.supplier?.name, r.supplier_invoice_ref),
    pill: (r) => statusLabel(pick(r, "status")),
    fields: [
      [(r) => pick(r, "invoiceNumber", "invoice_number") ?? "—", "PI No"],
      [(r) => dm(pick(r, "invoiceDate", "invoice_date")), "Date"],
      [(r) => dm(pick(r, "dueDate", "due_date")), "Due"],
      [(r) => rmField(pick(r, "totalCenti", "total_centi")), "Amount"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "unpaid", label: "Unpaid", match: (r) => eq(pick(r, "status"), "unpaid") },
      { key: "paid", label: "Paid", match: (r) => eq(pick(r, "status"), "paid") },
      { key: "overdue", label: "Overdue", match: (r) => eq(pick(r, "status"), "overdue") },
    ],
    sorts: [
      { key: "due", label: "Due date", cmp: (a, b) => byDate(pick(a, "dueDate", "due_date"), pick(b, "dueDate", "due_date")) },
      { key: "total", label: "Amount", cmp: (a, b) => byNum(pick(a, "totalCenti", "total_centi"), pick(b, "totalCenti", "total_centi")) },
    ],
  },

  // purchase-returns.get('/') → { purchaseReturns: [...] }; cols return_number,
  // return_date, status, refund_centi + nested supplier:{code,name}.
  // Design m-preturn: Return No/Date/Reason/Value + status pill. Real cols:
  // return_number, return_date, reason, refund_centi, status, nested supplier.
  "purchase-returns": {
    title: "Purchase Returns",
    eyebrow: "Procurement",
    placeholder: "Search return · supplier",
    endpoint: "/purchase-returns?limit=300&fields=minimal",
    listKey: "purchaseReturns",
    primary: (r) => r.supplier?.name || r.return_number,
    secondary: (r) => join(r.return_number, r.status, dm(r.return_date)),
    right: (r) => r.refund_centi,
    rightMoney: true,
    search: (r) => join(r.return_number, r.supplier?.name, r.credit_note_ref),
    pill: (r) => statusLabel(pick(r, "status")),
    fields: [
      [(r) => pick(r, "returnNumber", "return_number") ?? "—", "Return No"],
      [(r) => dm(pick(r, "returnDate", "return_date")), "Date"],
      [(r) => pick(r, "reason") ?? "—", "Reason"],
      [(r) => rmField(pick(r, "refundCenti", "refund_centi")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "open", label: "Open", match: (r) => eq(pick(r, "status"), "open") },
      { key: "completed", label: "Completed", match: (r) => eq(pick(r, "status"), "completed") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "returnDate", "return_date"), pick(b, "returnDate", "return_date")) }],
  },

  // purchase-consignment-orders.get('/') → { purchaseOrders: [...] }; cols
  // pc_number, po_date, status, total_centi + nested supplier:{code,name}.
  "purchase-consignment-orders": {
    title: "Purchase Consignment Orders",
    eyebrow: "Consignment",
    endpoint: "/purchase-consignment-orders",
    listKey: "purchaseOrders",
    primary: (r) => r.supplier?.name || r.pc_number,
    secondary: (r) => join(r.pc_number, r.status, dm(r.po_date)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.pc_number, r.supplier?.name),
  },

  // purchase-consignment-receives.get('/') → { grns: [...] }; cols
  // receive_number, received_at, status, total_centi + nested supplier + pc_order_no.
  "purchase-consignment-receives": {
    title: "Purchase Consignment Receives",
    eyebrow: "Consignment",
    endpoint: "/purchase-consignment-receives",
    listKey: "grns",
    primary: (r) => r.supplier?.name || r.receive_number,
    secondary: (r) => join(r.receive_number, r.status, dm(r.received_at)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.receive_number, r.supplier?.name, r.pc_order_no),
  },

  // purchase-consignment-returns.get('/') → { purchaseReturns: [...] }; cols
  // return_number, return_date, status, refund_centi.
  "purchase-consignment-returns": {
    title: "Purchase Consignment Returns",
    eyebrow: "Consignment",
    endpoint: "/purchase-consignment-returns",
    listKey: "purchaseReturns",
    primary: (r) => r.return_number,
    secondary: (r) => join(r.status, dm(r.return_date)),
    right: (r) => r.refund_centi,
    rightMoney: true,
    search: (r) => join(r.return_number),
  },

  // consignment-orders.get('/') → { salesOrders: [...] }; cols doc_no,
  // debtor_name, so_date, status, local_total_centi.
  "consignment-orders": {
    title: "Consignment Orders",
    eyebrow: "Consignment",
    endpoint: "/consignment-orders?limit=500",
    listKey: "salesOrders",
    primary: (r) => r.debtor_name || r.doc_no,
    secondary: (r) => join(r.doc_no, r.status, dm(r.so_date)),
    right: (r) => r.local_total_centi,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.doc_no, r.ref, r.po_doc_no),
  },

  // consignment-returns.get('/') → { deliveryReturns: [...] }; cols
  // return_number, debtor_name, return_date, status, refund_centi.
  "consignment-returns": {
    title: "Consignment Returns",
    eyebrow: "Consignment",
    endpoint: "/consignment-returns?limit=500",
    listKey: "deliveryReturns",
    primary: (r) => r.debtor_name || r.return_number,
    secondary: (r) => join(r.return_number, r.status, dm(r.return_date)),
    right: (r) => r.refund_centi,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.return_number, r.do_doc_no),
  },

  // products.get('/') → { products: [...] }; cols sku, name, stock, size_display
  // + nested category:{label}, series:{label}.
  // Design label "Products & Maintenance" (m-products).
  // Design m-products: SKU/Brand/Price + category pill. Real cols: sku, name,
  // flat_price (sen), nested category.label. Brand has NO column → OMITTED.
  // Price is flat only (size_variants have per-size prices, shown as "—" here).
  products: {
    title: "Products & Maintenance",
    eyebrow: "Catalogue",
    placeholder: "Search name · SKU",
    endpoint: "/products",
    listKey: "products",
    primary: (r) => r.name || r.sku,
    secondary: (r) => join(r.sku, r.category?.label, r.size_display),
    right: (r) => (r.stock == null ? "" : `${r.stock}`),
    search: (r) => join(r.name, r.sku, r.category?.label, r.series?.label),
    pill: (r) => pick(r.category, "label", "name") ?? "",
    fields: [
      [(r) => pick(r, "sku") ?? "—", "SKU"],
      [(r) => rmField(pick(r, "flatPrice", "flat_price")), "Price"],
    ],
    sorts: [
      { key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) },
      { key: "price", label: "Price", cmp: (a, b) => byNum(pick(a, "flatPrice", "flat_price"), pick(b, "flatPrice", "flat_price")) },
    ],
  },

  // Design m-mrp: SKU/Required/On hand/Shortage/Incoming + state pill. MrpSku
  // is a COMPUTED type (camelCase keys): itemCode, description, qtyNeeded,
  // stock, shortage, poOutstanding, category, warehouseCode/Name. State pill
  // (In stock / Shortage / On PO) is derived from shortage/poOutstanding.
  mrp: {
    title: "MRP · Stock Status",
    eyebrow: "Procurement",
    placeholder: "Search product · SKU",
    endpoint: "/mrp",
    listKey: "skus",
    primary: (r) => pick(r, "description", "itemCode", "item_code") ?? "—",
    secondary: (r) => join(pick(r, "itemCode", "item_code"), pick(r, "category"), pick(r, "warehouseCode", "warehouse_code", "warehouseName", "warehouse_name")),
    search: (r) => join(pick(r, "description"), pick(r, "itemCode", "item_code"), pick(r, "category")),
    pill: (r) => mrpState(r),
    fields: [
      [(r) => pick(r, "itemCode", "item_code") ?? "—", "SKU"],
      [(r) => { const n = pick(r, "qtyNeeded", "qty_needed"); return n == null ? "—" : String(n); }, "Required"],
      [(r) => { const n = pick(r, "stock"); return n == null ? "—" : String(n); }, "On hand"],
      [(r) => { const n = pick(r, "shortage"); return n == null ? "—" : String(n); }, "Shortage"],
      [(r) => { const n = pick(r, "poOutstanding", "po_outstanding"); return n == null ? "—" : String(n); }, "Incoming"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "in", label: "In stock", match: (r) => mrpState(r) === "In stock" },
      { key: "short", label: "Shortage", match: (r) => mrpState(r) === "Shortage" },
      { key: "po", label: "On PO", match: (r) => mrpState(r) === "On PO" },
    ],
    sorts: [
      { key: "short", label: "Shortage", cmp: (a, b) => byNum(pick(a, "shortage"), pick(b, "shortage")) },
      { key: "name", label: "Name", cmp: (a, b) => byStr(pick(a, "description", "itemCode"), pick(b, "description", "itemCode")) },
    ],
  },

  // Design m-fleet: Type/Capacity/Driver/Region + status pill. Real cols: plate,
  // type, is_internal, capacity_m3, capacity_kg, active. Driver and Region have
  // NO column on a lorry (lorries aren't linked to drivers) → OMITTED. Status
  // pill: Off (inactive) / In-house / Outsource.
  fleet: {
    title: "Fleet",
    eyebrow: "Transportation",
    placeholder: "Search lorry · type",
    endpoint: "/lorries",
    listKey: "lorries",
    primary: (r) => r.plate,
    secondary: (r) => join(r.type, r.capacity_kg ? `${r.capacity_kg} kg` : r.capacity_m3 ? `${r.capacity_m3} m3` : null),
    right: (r) => (r.active === false ? "Off" : r.is_internal ? "In-house" : "Outsource"),
    search: (r) => join(r.plate, r.type),
    pill: (r) => (pick(r, "active") === false ? "Off" : pick(r, "isInternal", "is_internal") ? "In-house" : "Outsource"),
    fields: [
      [(r) => pick(r, "type") ?? "—", "Type"],
      [(r) => capacityLabel(r), "Capacity"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "inhouse", label: "In-house", match: (r) => pick(r, "active") !== false && !!pick(r, "isInternal", "is_internal") },
      { key: "outsource", label: "Outsource", match: (r) => pick(r, "active") !== false && !pick(r, "isInternal", "is_internal") },
      { key: "off", label: "Off", match: (r) => pick(r, "active") === false },
    ],
    sorts: [{ key: "plate", label: "Lorry", cmp: (a, b) => byStr(a.plate, b.plate) }],
    form: FORM_FLEET,
  },
};

/** Lorry capacity display — prefer kg, fall back to m3, else em-dash. */
const capacityLabel = (r: any): string => {
  const kg = pick(r, "capacityKg", "capacity_kg");
  if (kg != null) return `${Number(kg).toLocaleString("en-MY")} kg`;
  const m3 = pick(r, "capacityM3", "capacity_m3");
  if (m3 != null) return `${m3} m3`;
  return "—";
};
