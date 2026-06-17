// ----------------------------------------------------------------------------
// Suppliers — master + supplier_material_bindings management.
//
// 1:1 clone of 2990s apps/backend/src/pages/Suppliers.tsx. Same status chips,
// search box, list table and create drawer (same field groups + same form
// keys). The .module.css is brought over verbatim.
//
// SEAM changes (the only deviations from 2990s):
//   - Data layer: 2990s lib/suppliers-queries (authedFetch + @tanstack/react-query)
//     -> Houzs api client (frontend/src/api/client.ts) + @tanstack/react-query.
//     The query/response SHAPES are identical to 2990s. (rule #7)
//   - Components: 2990s @2990s/design-system Button -> Houzs components/Button;
//     2990s DataGrid -> a plain <table> rendered with the verbatim .module.css
//     classes (DataGrid is a large 2990s-only component tree; inlining the
//     table keeps the look without pulling it). (rule #9)
//   - Product layer: 2990s's Supply Category filter chips + SupplyCategoryPicker
//     are fed by a furniture category pool (mfg). Replaced with a plain text
//     "Category" input (same `category` form key). PhoneInput (E.164) -> plain
//     text inputs. (product-layer note)
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Plus, X } from "lucide-react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { Button } from "../components/Button";
import { api } from "../api/client";
import styles from "./Suppliers.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* ════════════════════════════════════════════════════════════════════════
   Types + query hooks — ported from 2990s lib/suppliers-queries.ts. Shapes
   are identical to 2990s; the fetch layer is Houzs's `api` client (carries the
   bearer token). Co-located here (the slice ships 4 files, no shared lib) and
   re-exported for SupplierDetail.tsx.
   ════════════════════════════════════════════════════════════════════════ */

export type SupplierStatus = "ACTIVE" | "INACTIVE" | "BLOCKED";
export type Currency = "MYR" | "RMB" | "USD" | "SGD";
export type MaterialKind = "mfg_product" | "fabric" | "raw";
export type PoStatus = "SUBMITTED" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CANCELLED";

export type StatementType = "OPEN_ITEM" | "BALANCE_FORWARD" | "NO_STATEMENT";
export type AgingBasis = "INVOICE_DATE" | "DUE_DATE";

export type SupplierRow = {
  id: string;
  code: string;
  name: string;
  whatsapp_number: string | null;
  email: string | null;
  contact_person: string | null;
  phone: string | null;
  address: string | null;
  state: string | null;
  payment_terms: string | null;
  status: SupplierStatus;
  rating: number;
  notes: string | null;
  supplier_type: string | null;
  category: string | null;
  tin_number: string | null;
  business_reg_no: string | null;
  postcode: string | null;
  area: string | null;
  mobile: string | null;
  fax: string | null;
  website: string | null;
  attention: string | null;
  business_nature: string | null;
  country: string;
  currency: Currency;
  statement_type: StatementType;
  aging_basis: AgingBasis;
  credit_limit_sen: number;
  created_at: string;
  updated_at: string;
  /* 2990s list view auto-derives this from assigned SKUs; Houzs omits it
     until the Products slice lands. Kept optional to match the shape. */
  derived_category?: string | null;
};

/** Per-category supplier cost matrix (mirrors 2990s). Two concrete shapes the
 *  UI cares about; everything else (or null) falls back to unit_price_centi. */
export type SofaPriceMatrix = Record<string, { P1?: number; P2?: number; P3?: number }>;
export type BedframePriceMatrix = { P1?: number; P2?: number };
export type PriceMatrix = SofaPriceMatrix | BedframePriceMatrix | Record<string, unknown>;

export type BindingRow = {
  id: string;
  supplier_id: string;
  material_kind: MaterialKind;
  material_code: string;
  material_name: string;
  supplier_sku: string;
  unit_price_centi: number;
  currency: Currency;
  lead_time_days: number;
  payment_terms_override: string | null;
  moq: number;
  price_valid_from: string | null;
  price_valid_to: string | null;
  is_main_supplier: boolean;
  notes: string | null;
  price_matrix: PriceMatrix | null;
  created_at: string;
  updated_at: string;
};

export type SupplierScorecard = {
  supplierId: string;
  onTimeRate: number;
  defectRate: number;
  averageLeadDays: number;
  totalPOs: number;
  receivedPOs: number;
  onTimeCount: number;
  last10POs: Array<{
    id: string;
    poNo: string;
    status: PoStatus;
    poDate: string;
    expectedDate: string | null;
    receivedDate: string | null;
    totalCenti: number;
    orderedQty: number;
    receivedQty: number;
  }>;
};

export type NewBinding = {
  materialKind: MaterialKind;
  materialCode: string;
  materialName: string;
  supplierSku: string;
  unitPriceCenti?: number;
  currency?: Currency;
  leadTimeDays?: number;
  moq?: number;
  isMainSupplier?: boolean;
  paymentTermsOverride?: string;
  priceValidFrom?: string;
  priceValidTo?: string;
  notes?: string;
  priceMatrix?: PriceMatrix | null;
};

/* ── Suppliers ──────────────────────────────────────────────────────── */

export function useSuppliers(opts?: { status?: SupplierStatus; search?: string }) {
  return useQuery({
    queryKey: ["suppliers", opts?.status ?? "all", opts?.search ?? ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.search) params.set("search", opts.search);
      const res = await api.get<{ suppliers: SupplierRow[] }>(
        `/api/suppliers${params.toString() ? `?${params.toString()}` : ""}`,
      );
      return res.suppliers;
    },
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useSupplierDetail(id: string | null) {
  return useQuery({
    queryKey: ["supplier-detail", id],
    queryFn: () =>
      api.get<{ supplier: SupplierRow; bindings: BindingRow[] }>(`/api/suppliers/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useSupplierScorecard(id: string | null) {
  return useQuery({
    queryKey: ["supplier-scorecard", id],
    queryFn: () => api.get<SupplierScorecard>(`/api/suppliers/${id}/scorecard`),
    enabled: Boolean(id),
    staleTime: 60_000,
    retry: 1,
    retryDelay: 800,
  });
}

export function useCreateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<SupplierRow>) =>
      api.post<{ supplier: SupplierRow }>(`/api/suppliers`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }),
  });
}

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<SupplierRow> & { id: string }) =>
      api.patch<{ supplier: SupplierRow }>(`/api/suppliers/${id}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["supplier-detail", vars.id] });
    },
  });
}

/* ── Bindings ───────────────────────────────────────────────────────── */

export function useCreateBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, ...body }: NewBinding & { supplierId: string }) =>
      api.post<{ binding: BindingRow }>(`/api/suppliers/${supplierId}/bindings`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["supplier-detail", vars.supplierId] });
      qc.invalidateQueries({ queryKey: ["suppliers-for-material"] });
    },
  });
}

export function useCreateBindingsBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, bindings }: { supplierId: string; bindings: NewBinding[] }) =>
      api.post<{ inserted: number; skipped: number; bindings: BindingRow[] }>(
        `/api/suppliers/${supplierId}/bindings/batch`,
        { bindings },
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["supplier-detail", vars.supplierId] });
      qc.invalidateQueries({ queryKey: ["suppliers-for-material"] });
    },
  });
}

export function useUpdateBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      supplierId,
      bindingId,
      ...body
    }: Partial<NewBinding> & { supplierId: string; bindingId: string }) =>
      api.patch<{ binding: BindingRow }>(`/api/suppliers/${supplierId}/bindings/${bindingId}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["supplier-detail", vars.supplierId] });
      qc.invalidateQueries({ queryKey: ["suppliers-for-material"] });
    },
  });
}

export function useDeleteBinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ supplierId, bindingId }: { supplierId: string; bindingId: string }) =>
      api.del<void>(`/api/suppliers/${supplierId}/bindings/${bindingId}`),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["supplier-detail", vars.supplierId] });
      qc.invalidateQueries({ queryKey: ["suppliers-for-material"] });
    },
  });
}

export type UpdateBindingMutation = UseMutationResult<
  { binding: BindingRow },
  Error,
  Partial<NewBinding> & { supplierId: string; bindingId: string }
>;
export type DeleteBindingMutation = UseMutationResult<
  void,
  Error,
  { supplierId: string; bindingId: string }
>;

/* ════════════════════════════════════════════════════════════════════════
   Suppliers list page
   ════════════════════════════════════════════════════════════════════════ */

const STATUS_CHIPS: { value: "all" | SupplierStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
  { value: "BLOCKED", label: "Blocked" },
];

const STATUS_CLASS: Record<SupplierStatus, string> = {
  ACTIVE: styles.statusActive ?? "",
  INACTIVE: styles.statusInactive ?? "",
  BLOCKED: styles.statusBlocked ?? "",
};

export const Suppliers = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"all" | SupplierStatus>("all");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

  const { data, isLoading, error } = useSuppliers({
    status: status === "all" ? undefined : status,
    search: search.trim() || undefined,
  });

  const rows = useMemo(() => data ?? [], [data]);

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Suppliers</h1>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus {...ICON} />
          <span>New Supplier</span>
        </Button>
      </div>

      <div className={styles.headerRow}>
        <div className={styles.statusChips}>
          {STATUS_CHIPS.map((c) => (
            <StatusChip
              key={c.value}
              active={status === c.value}
              onClick={() => setStatus(c.value)}
            >
              {c.label}
            </StatusChip>
          ))}
        </div>

        <div className={styles.searchBox}>
          <Search {...ICON} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search by code / name / contact…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <p className={styles.eyebrow}>
        {isLoading ? "Loading suppliers…" : `${rows.length} suppliers`}
      </p>

      {error && !isLoading && (
        <div className={styles.bannerWarn}>
          <strong>Failed to load suppliers.</strong>{" "}
          {error instanceof Error ? error.message : String(error)}
          <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-12)" }}>
            If this keeps happening, sign out and back in — your session may have expired — or let IT know.
          </span>
        </div>
      )}

      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Supply Category</th>
              <th>Contact</th>
              <th>Phone</th>
              <th>State</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !isLoading ? (
              <tr>
                <td colSpan={7}>
                  <p className={styles.emptyRow}>No suppliers yet.</p>
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} onClick={() => navigate(`/suppliers/${r.id}`)}>
                  <td>
                    <span className={styles.codeChip}>{r.code}</span>
                  </td>
                  <td>{r.name}</td>
                  <td>
                    <span style={{ color: "var(--fg-muted)" }}>{r.category || "—"}</span>
                  </td>
                  <td>{r.contact_person ?? "—"}</td>
                  <td>{r.phone ?? r.whatsapp_number ?? "—"}</td>
                  <td>{r.state ?? "—"}</td>
                  <td>
                    <span className={`${styles.statusPill} ${STATUS_CLASS[r.status]}`}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {creating && <SupplierCreateDrawer onClose={() => setCreating(false)} />}
    </div>
  );
};

const StatusChip = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      fontFamily: "var(--font-button)",
      fontSize: "var(--fs-13)",
      fontWeight: 600,
      letterSpacing: "0.02em",
      padding: "var(--space-2) var(--space-4)",
      borderRadius: "var(--radius-pill)",
      border: active ? "1px solid var(--c-ink)" : "1px solid var(--line)",
      background: active ? "var(--c-ink)" : "var(--c-paper)",
      color: active ? "var(--c-cream)" : "var(--c-ink)",
      cursor: "pointer",
    }}
  >
    {children}
  </button>
);

/* ════════════════════════════════════════════════════════════════════════
   Create drawer (edit lives on the full /suppliers/:id page now)
   ════════════════════════════════════════════════════════════════════════ */

const SupplierCreateDrawer = ({ onClose }: { onClose: () => void }) => (
  <>
    <div className={styles.backdrop} onClick={onClose} />
    <aside className={styles.drawer}>
      <header className={styles.drawerHeader}>
        <h2 className={styles.drawerTitle}>New Supplier</h2>
        <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
          <X {...ICON} />
        </button>
      </header>
      <CreateForm onClose={onClose} />
    </aside>
  </>
);

const CreateForm = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateSupplier();
  const [form, setForm] = useState<Record<string, string | number>>({
    code: "",
    name: "",
    /* PR #40 — full master record */
    supplierType: "",
    category: "",
    tinNumber: "",
    businessRegNo: "",
    contactPerson: "",
    attention: "",
    phone: "",
    mobile: "",
    fax: "",
    whatsappNumber: "",
    email: "",
    website: "",
    address: "",
    postcode: "",
    area: "",
    state: "",
    businessNature: "",
    paymentTerms: "",
    rating: 0,
    notes: "",
  });
  const onChange = (k: string, v: string | number) => setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    const code = String(form.code ?? "").trim();
    const name = String(form.name ?? "").trim();
    if (!code || !name) {
      alert("Code and Name are required.");
      return;
    }
    create.mutate(
      {
        ...form,
        rating: Number(form.rating) || 0,
      } as unknown as Partial<SupplierRow>,
      { onSuccess: onClose },
    );
  };

  return (
    <>
      <div className={styles.drawerBody}>
        <SupplierFields form={form} onChange={onChange} />
      </div>
      <footer className={styles.drawerFooter}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create"}
        </Button>
      </footer>
    </>
  );
};

const SupplierFields = ({
  form,
  onChange,
}: {
  form: Record<string, string | number>;
  onChange: (k: string, v: string | number) => void;
}) => (
  <div className={styles.section}>
    <p className={styles.eyebrow}>Identity</p>
    <div className={styles.formGrid}>
      <Field label="Credit Account *" value={(form.code as string) ?? ""} onChange={(v) => onChange("code", v)} />
      <Field label="Company Name *" value={(form.name as string) ?? ""} onChange={(v) => onChange("name", v)} />
      <Field label="Supplier Type" value={(form.supplierType as string) ?? ""} onChange={(v) => onChange("supplierType", v)} />
      {/* Product-layer note: 2990s used a furniture-pool SupplyCategoryPicker
          here; replaced with a plain text input (same `category` form key). */}
      <Field label="Supply Category" value={(form.category as string) ?? ""} onChange={(v) => onChange("category", v)} />
      <Field label="TIN Number" value={(form.tinNumber as string) ?? ""} onChange={(v) => onChange("tinNumber", v)} />
      <Field label="Business Reg No" value={(form.businessRegNo as string) ?? ""} onChange={(v) => onChange("businessRegNo", v)} />
    </div>
    <p className={styles.eyebrow} style={{ marginTop: "var(--space-3)" }}>Contact</p>
    <div className={styles.formGrid}>
      <Field label="Contact Person" value={(form.contactPerson as string) ?? ""} onChange={(v) => onChange("contactPerson", v)} />
      <Field label="Attention" value={(form.attention as string) ?? ""} onChange={(v) => onChange("attention", v)} />
      {/* Product-layer note: 2990s PhoneInput (E.164) -> plain text inputs. */}
      <Field label="Phone" value={(form.phone as string) ?? ""} onChange={(v) => onChange("phone", v)} />
      <Field label="Mobile" value={(form.mobile as string) ?? ""} onChange={(v) => onChange("mobile", v)} />
      <Field label="WhatsApp" value={(form.whatsappNumber as string) ?? ""} onChange={(v) => onChange("whatsappNumber", v)} />
      <Field label="Fax" value={(form.fax as string) ?? ""} onChange={(v) => onChange("fax", v)} />
      <Field label="Email" value={(form.email as string) ?? ""} onChange={(v) => onChange("email", v)} />
      <Field label="Website" value={(form.website as string) ?? ""} onChange={(v) => onChange("website", v)} />
    </div>
    <p className={styles.eyebrow} style={{ marginTop: "var(--space-3)" }}>Commercial</p>
    <div className={styles.formGrid}>
      <Field label="Payment Terms" value={(form.paymentTerms as string) ?? ""} onChange={(v) => onChange("paymentTerms", v)} />
      <Field label="Business Nature" value={(form.businessNature as string) ?? ""} onChange={(v) => onChange("businessNature", v)} />
    </div>
    <p className={styles.eyebrow} style={{ marginTop: "var(--space-3)" }}>Address</p>
    <div className={styles.formGrid}>
      <Field label="State" value={(form.state as string) ?? ""} onChange={(v) => onChange("state", v)} />
      <Field label="Area" value={(form.area as string) ?? ""} onChange={(v) => onChange("area", v)} />
      <Field label="Postcode" value={(form.postcode as string) ?? ""} onChange={(v) => onChange("postcode", v)} />
      <Field
        label="Billing Address"
        value={(form.address as string) ?? ""}
        onChange={(v) => onChange("address", v)}
        multiline
        gridFull
      />
      <Field
        label="Notes"
        value={(form.notes as string) ?? ""}
        onChange={(v) => onChange("notes", v)}
        multiline
        gridFull
      />
    </div>
  </div>
);

const Field = ({
  label,
  value,
  onChange,
  multiline,
  gridFull,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  gridFull?: boolean;
}) => (
  <label className={`${styles.field} ${gridFull ? styles.formGridFull : ""}`}>
    <span className={styles.fieldLabel}>{label}</span>
    {multiline ? (
      <textarea
        className={styles.fieldTextarea}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    ) : (
      <input
        className={styles.fieldInput}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )}
  </label>
);
