import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { Panel } from "../../components/Panel";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { api, buildQuery } from "../../api/client";
import { SCM, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// Response shape from GET /api/scm/suppliers — snake_case, verbatim from the
// Hono route (it returns the suppliers_with_derived_category view).
export interface SupplierRow {
  id: string;
  code: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  category: string | null;
  derived_category: string | null;
  supplier_type: string | null;
  currency: string | null;
  status: string;
  rating: number | null;
  state: string | null;
  payment_terms: string | null;
  credit_limit_sen: number | null;
}

const STATUS_TABS = ["ACTIVE", "INACTIVE", "BLOCKED", "all"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(status),
      )}
    >
      {status}
    </span>
  );
}

export function ScmSuppliers() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusTab>("ACTIVE");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const list = useQuery<{ suppliers: SupplierRow[] }>(
    () =>
      api.get(
        `${SCM}/suppliers${buildQuery({
          status: status === "all" ? undefined : status,
          search: search || undefined,
        })}`,
      ),
    [status, search],
  );

  const rows = list.data?.suppliers ?? null;

  const columns: Column<SupplierRow>[] = [
    {
      key: "code",
      label: "Code",
      render: (r) => <span className="font-mono text-[12px] text-ink">{r.code}</span>,
      getValue: (r) => r.code,
    },
    {
      key: "name",
      label: "Name",
      render: (r) => <span className="font-medium text-ink">{r.name}</span>,
      getValue: (r) => r.name,
    },
    {
      key: "category",
      label: "Category",
      render: (r) => r.derived_category || r.category || "—",
      getValue: (r) => r.derived_category || r.category || "",
    },
    {
      key: "contact",
      label: "Contact",
      render: (r) => r.contact_person || "—",
      getValue: (r) => r.contact_person || "",
    },
    {
      key: "phone",
      label: "Phone",
      render: (r) => r.phone || r.mobile || "—",
      getValue: (r) => r.phone || r.mobile || "",
    },
    {
      key: "currency",
      label: "Curr.",
      render: (r) => r.currency || "MYR",
      getValue: (r) => r.currency || "MYR",
    },
    {
      key: "rating",
      label: "Rating",
      align: "right",
      render: (r) => (r.rating ? r.rating.toFixed(1) : "—"),
      getValue: (r) => r.rating ?? 0,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusPill status={r.status} />,
      getValue: (r) => r.status,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Suppliers"
        description="Vendor master + per-SKU supplier cost bindings."
        primaryAction={
          <Button icon={<Plus size={15} />} onClick={() => setShowCreate(true)}>
            New Supplier
          </Button>
        }
      />

      {/* Status filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {STATUS_TABS.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={cn(
              "rounded-md border px-3 py-1 text-[12px] font-semibold capitalize transition-colors",
              status === s
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
            )}
          >
            {s === "all" ? "All" : s.toLowerCase()}
          </button>
        ))}
      </div>

      <DataTable
        tableId="scm_suppliers"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/suppliers/${r.id}`)}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search code, name, contact…",
        }}
        emptyLabel="No suppliers found"
        exportName="suppliers"
      />

      {showCreate && (
        <CreateSupplierPanel
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            list.reload();
            navigate(`/scm/suppliers/${id}`);
          }}
        />
      )}
    </div>
  );
}

const CURRENCIES = ["MYR", "RMB", "USD", "SGD"];

function CreateSupplierPanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    code: "",
    name: "",
    contactPerson: "",
    phone: "",
    email: "",
    category: "",
    currency: "MYR",
    paymentTerms: "",
    state: "",
    notes: "",
  });
  const dirty = Object.values(form).some((v) => v.trim() !== "" && v !== "MYR");
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit() {
    if (!form.code.trim()) {
      toast.error("Code is required");
      return;
    }
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ supplier: { id: string } }>(`${SCM}/suppliers`, {
        code: form.code.trim(),
        name: form.name.trim(),
        contactPerson: form.contactPerson || undefined,
        phone: form.phone || undefined,
        email: form.email || undefined,
        category: form.category || undefined,
        currency: form.currency,
        paymentTerms: form.paymentTerms || undefined,
        state: form.state || undefined,
        notes: form.notes || undefined,
      });
      toast.success("Supplier created");
      onCreated(res.supplier.id);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(msg.includes("duplicate_code") ? "That code already exists" : "Failed to create supplier");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      dirty={dirty}
      onAttemptClose={onClose}
      title="New Supplier"
      subtitle="Create a vendor master record."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Create Supplier"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Code" required>
          <Input value={form.code} onChange={(v) => set("code", v)} placeholder="e.g. SUP-001" />
        </Field>
        <Field label="Name" required>
          <Input value={form.name} onChange={(v) => set("name", v)} placeholder="Supplier name" />
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
            <Input value={form.category} onChange={(v) => set("category", v)} placeholder="e.g. Fabric" />
          </Field>
          <Field label="Currency">
            <Select value={form.currency} onChange={(v) => set("currency", v)} options={CURRENCIES} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Payment Terms">
            <Input value={form.paymentTerms} onChange={(v) => set("paymentTerms", v)} placeholder="e.g. 30 days" />
          </Field>
          <Field label="State">
            <Input value={form.state} onChange={(v) => set("state", v)} />
          </Field>
        </div>
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

// ── Small form primitives (local; shared SCM form kit can extract later) ──
export function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
        {required && <span className="ml-0.5 text-err">*</span>}
      </span>
      {children}
    </label>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
    />
  );
}

export function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
