import { useState } from "react";
import { Plus, RefreshCw, X, Trash2 } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { api, buildQuery } from "../api/client";
import { cn } from "../lib/utils";

// Ported from the 2990s ERP supplier master. The scm_* namespace keeps this
// distinct from the AutoCount-synced Creditors and the ASSR service suppliers.
export interface ScmSupplier {
  id: string;
  code: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  whatsapp_number: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  payment_terms: string | null;
  status: string;
  rating: number;
  notes: string | null;
  supplier_type: string | null;
  category: string | null;
  currency: string;
  credit_limit_sen: number;
  created_at: string;
  updated_at: string;
}

interface ListResp {
  data: ScmSupplier[];
  page: number;
  per_page: number;
  total: number;
}

const FILTER_KEYS = ["search", "status", "category", "page"] as const;
const STATUSES = ["ACTIVE", "INACTIVE", "BLOCKED"];
const STATUS_TONE: Record<string, string> = {
  ACTIVE: "bg-synced/10 text-synced",
  INACTIVE: "bg-bg text-ink-muted",
  BLOCKED: "bg-err/10 text-err",
};

export function SupplierMaster() {
  const toast = useToast();
  const [params, setParams] = useStickyFilters("scm-suppliers", FILTER_KEYS);
  const search = params.get("search") || "";
  const status = params.get("status") || "";
  const category = params.get("category") || "";
  const page = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);

  function patch(p: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(p)) {
      if (v === "" || (k === "page" && v === "1")) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }
  const setSearch = (v: string) => patch({ search: v, page: "1" });
  const setPage = (n: number) => patch({ page: String(n) });

  const [perPage, setPerPage] = useLocalStorage<number>("pp:scm-suppliers", 50);
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));
  const [editing, setEditing] = useState<ScmSupplier | "new" | null>(null);

  const list = useQuery<ListResp>(
    () =>
      api.get(
        `/api/scm-suppliers${buildQuery({
          search,
          status,
          category,
          page,
          per_page: perPage,
          ...sortParams,
        })}`,
      ),
    [search, status, category, page, perPage, sort?.key, sort?.dir],
  );

  async function remove(s: ScmSupplier) {
    if (!confirm(`Delete supplier "${s.name}" (${s.code})? This also removes its material bindings.`)) return;
    try {
      await api.del(`/api/scm-suppliers/${s.id}`);
      toast.success("Supplier deleted");
      list.reload();
    } catch (e: any) {
      toast.error(e?.message || "Delete failed");
    }
  }

  const columns: Column<ScmSupplier>[] = [
    {
      key: "code",
      label: "Code",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.code}</span>,
      getValue: (r) => r.code,
    },
    {
      key: "name",
      label: "Name",
      alwaysVisible: true,
      render: (r) => (
        <div>
          <div className="font-medium text-ink">{r.name}</div>
          {r.supplier_type && <div className="text-[11px] text-ink-muted">{r.supplier_type}</div>}
        </div>
      ),
      getValue: (r) => r.name,
    },
    {
      key: "contact",
      label: "Contact",
      render: (r) => (
        <div className="text-xs">
          {r.contact_person && <div>{r.contact_person}</div>}
          {(r.phone || r.whatsapp_number) && (
            <div className="text-ink-muted">{r.phone || r.whatsapp_number}</div>
          )}
          {!r.contact_person && !r.phone && !r.whatsapp_number && (
            <span className="text-ink-muted">—</span>
          )}
        </div>
      ),
      getValue: (r) => `${r.contact_person || ""} ${r.phone || ""}`.trim(),
    },
    {
      key: "category",
      label: "Category",
      render: (r) => <span className="text-xs">{r.category || "—"}</span>,
      getValue: (r) => r.category,
    },
    {
      key: "payment_terms",
      label: "Terms",
      render: (r) => <span className="text-xs">{r.payment_terms || "—"}</span>,
      getValue: (r) => r.payment_terms,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            STATUS_TONE[r.status] || "bg-bg text-ink-muted",
          )}
        >
          {r.status}
        </span>
      ),
      getValue: (r) => r.status,
    },
    {
      key: "actions",
      label: "",
      render: (r) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void remove(r);
          }}
          className="rounded p-1 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
          title="Delete supplier"
        >
          <Trash2 size={14} />
        </button>
      ),
      getValue: () => "",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Suppliers"
        description="Internal purchasing vendor master — codes, contacts, terms, and material price bindings."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<RefreshCw size={13} className={list.loading ? "animate-spin" : ""} />}
              onClick={() => list.reload()}
              disabled={list.loading}
            >
              Refresh
            </Button>
            <Button onClick={() => setEditing("new")} icon={<Plus size={13} />}>
              New supplier
            </Button>
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={status}
          onChange={(e) => patch({ status: e.target.value, page: "1" })}
          className="rounded border border-border bg-paper px-2 py-1 text-[12px]"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          value={category}
          onChange={(e) => patch({ category: e.target.value, page: "1" })}
          placeholder="Filter category…"
          className="rounded border border-border bg-paper px-2 py-1 text-[12px]"
        />
      </div>

      <DataTable
        tableId="scm-suppliers"
        exportName="scm-suppliers"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search code, name, contact, email, phone…",
        }}
        resetFilters={{
          active: !!(search || status || category),
          onReset: () => {
            const next = new URLSearchParams(params);
            FILTER_KEYS.forEach((k) => next.delete(k));
            setParams(next, { replace: true });
          },
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No suppliers yet — click New supplier to add one."
        getRowKey={(r) => r.id}
        onRowClick={(r) => setEditing(r)}
        serverSort
        onSortChange={handleSortChange}
      />

      {list.data && (
        <Pagination
          page={page}
          perPage={perPage}
          total={list.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
        />
      )}

      {editing && (
        <SupplierFormModal
          supplier={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            const wasNew = editing === "new";
            setEditing(null);
            list.reload();
            toast.success(wasNew ? "Supplier created" : "Supplier updated");
          }}
        />
      )}
    </div>
  );
}

const PAYMENT_TERMS = ["COD", "NET 7", "NET 14", "NET 30", "NET 60", "NET 90"];

function SupplierFormModal({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: ScmSupplier | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isEdit = !!supplier;
  const [f, setF] = useState({
    code: supplier?.code || "",
    name: supplier?.name || "",
    contact_person: supplier?.contact_person || "",
    phone: supplier?.phone || "",
    whatsapp_number: supplier?.whatsapp_number || "",
    email: supplier?.email || "",
    category: supplier?.category || "",
    supplier_type: supplier?.supplier_type || "",
    payment_terms: supplier?.payment_terms || "",
    status: supplier?.status || "ACTIVE",
    currency: supplier?.currency || "MYR",
    address: supplier?.address || "",
    state: supplier?.state || "",
    postcode: supplier?.postcode || "",
    notes: supplier?.notes || "",
  });
  const [busy, setBusy] = useState(false);
  const set =
    (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setF((prev) => ({ ...prev, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.code.trim()) {
      toast.error("Code is required");
      return;
    }
    if (!f.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setBusy(true);
    try {
      if (isEdit) await api.patch(`/api/scm-suppliers/${supplier!.id}`, f);
      else await api.post("/api/scm-suppliers", f);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const field = "mt-0.5 w-full rounded-md border border-border bg-paper px-2 py-1.5 text-[12px]";
  const lbl = "text-[10px] font-semibold uppercase tracking-brand text-ink-muted";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? "Edit supplier" : "New supplier"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-border bg-surface shadow-slab animate-rise"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-4 py-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">Supply Chain</div>
            <div className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
              {isEdit ? `Edit ${supplier!.name}` : "New supplier"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-muted hover:bg-bg/60 hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
          <label className="block">
            <span className={lbl}>Code *</span>
            <input value={f.code} onChange={set("code")} className={field} placeholder="400-B002" autoFocus required />
          </label>
          <label className="block">
            <span className={lbl}>Name *</span>
            <input value={f.name} onChange={set("name")} className={field} placeholder="Company name" required />
          </label>
          <label className="block">
            <span className={lbl}>Contact person</span>
            <input value={f.contact_person} onChange={set("contact_person")} className={field} />
          </label>
          <label className="block">
            <span className={lbl}>Phone</span>
            <input value={f.phone} onChange={set("phone")} className={field} />
          </label>
          <label className="block">
            <span className={lbl}>WhatsApp</span>
            <input value={f.whatsapp_number} onChange={set("whatsapp_number")} className={field} />
          </label>
          <label className="block">
            <span className={lbl}>Email</span>
            <input value={f.email} onChange={set("email")} className={field} type="email" />
          </label>
          <label className="block">
            <span className={lbl}>Category</span>
            <input value={f.category} onChange={set("category")} className={field} placeholder="Bedframe / Fabric / Hardware" />
          </label>
          <label className="block">
            <span className={lbl}>Supplier type</span>
            <input value={f.supplier_type} onChange={set("supplier_type")} className={field} placeholder="Matrix / Distributor / Maker" />
          </label>
          <label className="block">
            <span className={lbl}>Payment terms</span>
            <input value={f.payment_terms} onChange={set("payment_terms")} className={field} list="scm-payment-terms" placeholder="NET 30" />
            <datalist id="scm-payment-terms">
              {PAYMENT_TERMS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className={lbl}>Status</span>
            <select value={f.status} onChange={set("status")} className={field}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={lbl}>Currency</span>
            <input value={f.currency} onChange={set("currency")} className={field} placeholder="MYR" />
          </label>
          <label className="block">
            <span className={lbl}>State</span>
            <input value={f.state} onChange={set("state")} className={field} />
          </label>
          <label className="block sm:col-span-2">
            <span className={lbl}>Address</span>
            <input value={f.address} onChange={set("address")} className={field} />
          </label>
          <label className="block">
            <span className={lbl}>Postcode</span>
            <input value={f.postcode} onChange={set("postcode")} className={field} />
          </label>
          <label className="block sm:col-span-2">
            <span className={lbl}>Notes</span>
            <textarea value={f.notes} onChange={set("notes")} rows={2} className={cn(field, "resize-none")} />
          </label>
        </div>

        <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-surface px-4 py-3">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" disabled={busy} className="flex-1" icon={<Plus size={13} />}>
            {busy ? "Saving…" : isEdit ? "Save changes" : "Create supplier"}
          </Button>
        </div>
      </form>
    </div>
  );
}
