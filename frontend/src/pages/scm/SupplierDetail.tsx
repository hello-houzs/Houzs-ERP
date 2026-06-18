import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Pencil } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { Panel } from "../../components/Panel";
import { EmptyState } from "../../components/EmptyState";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { api } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { Field, Input, Select } from "./Suppliers";

interface SupplierDetail {
  id: string;
  code: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  mobile: string | null;
  whatsapp_number: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  category: string | null;
  supplier_type: string | null;
  payment_terms: string | null;
  currency: string | null;
  status: string;
  rating: number | null;
  credit_limit_sen: number | null;
  country: string | null;
  notes: string | null;
}

interface Binding {
  id: string;
  material_kind: string;
  material_code: string;
  material_name: string;
  supplier_sku: string | null;
  unit_price_centi: number | null;
  currency: string | null;
  lead_time_days: number | null;
  moq: number | null;
  is_main_supplier: boolean;
  is_cost_anchor: boolean;
}

interface Scorecard {
  onTimeRate: number;
  defectRate: number;
  averageLeadDays: number;
  totalPOs: number;
  receivedPOs: number;
}

export function ScmSupplierDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);

  const detail = useQuery<{ supplier: SupplierDetail; bindings: Binding[] }>(
    () => api.get(`${SCM}/suppliers/${id}`),
    [id],
  );
  const score = useQuery<Scorecard>(() => api.get(`${SCM}/suppliers/${id}/scorecard`), [id]);

  const supplier = detail.data?.supplier;
  const bindings = detail.data?.bindings ?? null;

  if (detail.error) {
    return (
      <div>
        <BackLink onClick={() => navigate("/scm/suppliers")} />
        <EmptyState message="Failed to load supplier" description={detail.error} />
      </div>
    );
  }

  const bindingCols: Column<Binding>[] = [
    {
      key: "material_code",
      label: "Material Code",
      render: (b) => <span className="font-mono text-[12px]">{b.material_code}</span>,
      getValue: (b) => b.material_code,
    },
    { key: "material_name", label: "Material", render: (b) => b.material_name, getValue: (b) => b.material_name },
    {
      key: "kind",
      label: "Kind",
      render: (b) => <span className="text-[12px] capitalize text-ink-secondary">{b.material_kind.replace("_", " ")}</span>,
      getValue: (b) => b.material_kind,
    },
    { key: "sku", label: "Supplier SKU", render: (b) => b.supplier_sku || "—", getValue: (b) => b.supplier_sku || "" },
    {
      key: "price",
      label: "Unit Cost",
      align: "right",
      render: (b) => <span className="font-mono">{fmtCenti(b.unit_price_centi, b.currency ?? "MYR")}</span>,
      getValue: (b) => b.unit_price_centi ?? 0,
    },
    { key: "lead", label: "Lead (d)", align: "right", render: (b) => b.lead_time_days ?? 0, getValue: (b) => b.lead_time_days ?? 0 },
    { key: "moq", label: "MOQ", align: "right", render: (b) => b.moq ?? 0, getValue: (b) => b.moq ?? 0 },
    {
      key: "main",
      label: "Main",
      align: "center",
      render: (b) =>
        b.is_main_supplier ? (
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">Main</span>
        ) : (
          "—"
        ),
      getValue: (b) => (b.is_main_supplier ? 1 : 0),
    },
  ];

  return (
    <div>
      <BackLink onClick={() => navigate("/scm/suppliers")} />
      <PageHeader
        eyebrow={supplier ? `Supplier · ${supplier.code}` : "Supplier"}
        title={supplier?.name ?? (detail.loading ? "Loading…" : "Supplier")}
        primaryAction={
          supplier ? (
            <Button variant="secondary" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : undefined
        }
      />

      {/* Scorecard KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="On-Time Rate" value={score.data ? `${score.data.onTimeRate.toFixed(0)}%` : "—"} loading={score.loading} />
        <Kpi label="Defect Rate" value={score.data ? `${score.data.defectRate.toFixed(1)}%` : "—"} loading={score.loading} />
        <Kpi label="Avg Lead" value={score.data ? `${score.data.averageLeadDays.toFixed(0)}d` : "—"} loading={score.loading} />
        <Kpi
          label="Purchase Orders"
          value={score.data ? `${score.data.receivedPOs}/${score.data.totalPOs}` : "—"}
          sub={score.data ? "received / total" : undefined}
          loading={score.loading}
        />
      </div>

      {/* Master info */}
      {supplier && (
        <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-px w-3 bg-accent/60" />
            <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Master Record</h3>
            <span
              className={cn(
                "ml-auto inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                scmStatusClasses(supplier.status),
              )}
            >
              {supplier.status}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            <Info label="Code" value={supplier.code} mono />
            <Info label="Category" value={supplier.category} />
            <Info label="Contact" value={supplier.contact_person} />
            <Info label="Phone" value={supplier.phone || supplier.mobile} />
            <Info label="Email" value={supplier.email} />
            <Info label="Currency" value={supplier.currency} />
            <Info label="Payment Terms" value={supplier.payment_terms} />
            <Info label="State" value={supplier.state} />
            <Info label="Credit Limit" value={fmtCenti(supplier.credit_limit_sen, supplier.currency ?? "MYR")} />
            <Info label="Country" value={supplier.country} />
          </dl>
          {supplier.notes && (
            <div className="mt-4 border-t border-border-subtle pt-3 text-[13px] text-ink-secondary">{supplier.notes}</div>
          )}
        </div>
      )}

      {/* Bindings */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">SKU Cost Bindings</h3>
      </div>
      <DataTable
        tableId="scm_supplier_bindings"
        columns={bindingCols}
        rows={bindings}
        loading={detail.loading}
        getRowKey={(b) => b.id}
        emptyLabel="No SKU bindings yet"
        exportName="supplier-bindings"
      />

      {editing && supplier && (
        <EditSupplierPanel
          supplier={supplier}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            detail.reload();
          }}
        />
      )}
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
    >
      <ArrowLeft size={14} />
      Suppliers
    </button>
  );
}

function Kpi({ label, value, sub, loading }: { label: string; value: string; sub?: string; loading?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-1 font-display text-[22px] font-bold tracking-tight text-ink">{loading ? "…" : value}</div>
      {sub && <div className="text-[11px] text-ink-muted">{sub}</div>}
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-[13px] text-ink", mono && "font-mono")}>{value || "—"}</dd>
    </div>
  );
}

const CURRENCIES = ["MYR", "RMB", "USD", "SGD"];
const STATUSES = ["ACTIVE", "INACTIVE", "BLOCKED"];

function EditSupplierPanel({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: SupplierDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: supplier.name ?? "",
    contactPerson: supplier.contact_person ?? "",
    phone: supplier.phone ?? "",
    email: supplier.email ?? "",
    category: supplier.category ?? "",
    currency: supplier.currency ?? "MYR",
    status: supplier.status ?? "ACTIVE",
    paymentTerms: supplier.payment_terms ?? "",
    state: supplier.state ?? "",
    notes: supplier.notes ?? "",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit() {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      await api.patch(`${SCM}/suppliers/${supplier.id}`, {
        name: form.name.trim(),
        contactPerson: form.contactPerson,
        phone: form.phone,
        email: form.email,
        category: form.category,
        currency: form.currency,
        status: form.status,
        paymentTerms: form.paymentTerms,
        state: form.state,
        notes: form.notes,
      });
      toast.success("Supplier updated");
      onSaved();
    } catch {
      toast.error("Failed to update supplier");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      dirty
      onAttemptClose={onClose}
      title={`Edit ${supplier.code}`}
      subtitle="Update the vendor master record."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Name" required>
          <Input value={form.name} onChange={(v) => set("name", v)} />
        </Field>
        <Field label="Contact Person">
          <Input value={form.contactPerson} onChange={(v) => set("contactPerson", v)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone">
            <Input value={form.phone} onChange={(v) => set("phone", v)} />
          </Field>
          <Field label="Email">
            <Input value={form.email} onChange={(v) => set("email", v)} type="email" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <Input value={form.category} onChange={(v) => set("category", v)} />
          </Field>
          <Field label="Currency">
            <Select value={form.currency} onChange={(v) => set("currency", v)} options={CURRENCIES} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <Select value={form.status} onChange={(v) => set("status", v)} options={STATUSES} />
          </Field>
          <Field label="State">
            <Input value={form.state} onChange={(v) => set("state", v)} />
          </Field>
        </div>
        <Field label="Payment Terms">
          <Input value={form.paymentTerms} onChange={(v) => set("paymentTerms", v)} />
        </Field>
        <Field label="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={3}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </Field>
      </div>
    </Panel>
  );
}
