import { useState } from "react";
import { Plus, Star, Pencil } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { Panel } from "../../components/Panel";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { api, buildQuery } from "../../api/client";
import { SCM, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";
import { Field, Input } from "./Suppliers";

// Response shape from GET /api/scm/inventory/warehouses — snake_case, verbatim
// from the Hono route (backend/src/scm/routes/inventory.ts `inventory.get('/warehouses')`).
// This is the warehouse MASTER (physical stock locations), the same picker the
// Inventory/GRN/DO flows bind against. The /api/scm/warehouse route (singular) is
// a separate rack/bin layer, not this list.
export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  location: string | null;
  is_active: boolean;
  is_default: boolean;
}

function StatusPill({ active }: { active: boolean }) {
  const status = active ? "ACTIVE" : "INACTIVE";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(status),
      )}
    >
      {active ? "Active" : "Inactive"}
    </span>
  );
}

export function ScmWarehouses() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<WarehouseRow | null>(null);

  const list = useQuery<{ warehouses: WarehouseRow[] }>(
    () =>
      api.get(
        `${SCM}/inventory/warehouses${buildQuery({
          includeInactive: includeInactive ? "true" : undefined,
        })}`,
      ),
    [includeInactive],
  );

  // The warehouses endpoint has no server-side text search — filter loaded rows.
  const all = list.data?.warehouses ?? null;
  const q = search.trim().toLowerCase();
  const rows =
    all && q
      ? all.filter((w) =>
          [w.code, w.name, w.location].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)),
        )
      : all;

  const columns: Column<WarehouseRow>[] = [
    {
      key: "code",
      label: "Code",
      render: (w) => <span className="font-mono text-[12px] font-semibold text-ink">{w.code}</span>,
      getValue: (w) => w.code,
    },
    {
      key: "name",
      label: "Name",
      render: (w) => <span className="font-medium text-ink">{w.name}</span>,
      getValue: (w) => w.name,
    },
    {
      key: "location",
      label: "Location",
      render: (w) => w.location || "—",
      getValue: (w) => w.location || "",
    },
    {
      key: "is_default",
      label: "Default",
      align: "center",
      render: (w) =>
        w.is_default ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent">
            <Star size={12} className="fill-accent" />
            Default
          </span>
        ) : (
          "—"
        ),
      getValue: (w) => (w.is_default ? 1 : 0),
    },
    {
      key: "status",
      label: "Status",
      render: (w) => <StatusPill active={w.is_active} />,
      getValue: (w) => (w.is_active ? "Active" : "Inactive"),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      disableSort: true,
      render: (w) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditing(w);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
        >
          <Pencil size={12} />
          Edit
        </button>
      ),
      getValue: () => "",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Warehouses"
        description="Physical stock locations — the warehouse master that inventory, GRN, and DO bind against."
        primaryAction={
          <Button icon={<Plus size={15} />} onClick={() => setShowCreate(true)}>
            New Warehouse
          </Button>
        }
      />

      {/* Include-inactive filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {[
          { value: false, label: "Active only" },
          { value: true, label: "Include inactive" },
        ].map((opt) => (
          <button
            key={String(opt.value)}
            onClick={() => setIncludeInactive(opt.value)}
            className={cn(
              "rounded-md border px-3 py-1 text-[12px] font-semibold transition-colors",
              includeInactive === opt.value
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <DataTable
        tableId="scm_warehouses"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(w) => w.id}
        getRowClassName={(w) => (w.is_active ? undefined : "opacity-60")}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search code, name, location…",
        }}
        emptyLabel="No warehouses found"
        exportName="warehouses"
      />

      {showCreate && (
        <CreateWarehousePanel
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            list.reload();
          }}
        />
      )}

      {editing && (
        <EditWarehousePanel
          warehouse={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function CreateWarehousePanel({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    code: "",
    name: "",
    location: "",
    isDefault: false,
  });
  const dirty = form.code.trim() !== "" || form.name.trim() !== "" || form.location.trim() !== "" || form.isDefault;
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

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
      await api.post(`${SCM}/inventory/warehouses`, {
        code: form.code.trim(),
        name: form.name.trim(),
        location: form.location.trim() || undefined,
        isDefault: form.isDefault,
      });
      toast.success("Warehouse created");
      onCreated();
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(msg.includes("duplicate_code") ? "That code already exists" : "Failed to create warehouse");
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
      title="New Warehouse"
      subtitle="Create a physical stock location."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Create Warehouse"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Code" required>
          <Input value={form.code} onChange={(v) => set("code", v)} placeholder="e.g. KL / PJ / JB" />
        </Field>
        <Field label="Name" required>
          <Input value={form.name} onChange={(v) => set("name", v)} placeholder="e.g. KL Warehouse" />
        </Field>
        <Field label="Location">
          <Input value={form.location} onChange={(v) => set("location", v)} placeholder="Address / area" />
        </Field>
        <Checkbox
          label="Default warehouse"
          checked={form.isDefault}
          onChange={(v) => set("isDefault", v)}
        />
      </div>
    </Panel>
  );
}

function EditWarehousePanel({
  warehouse,
  onClose,
  onSaved,
}: {
  warehouse: WarehouseRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    code: warehouse.code ?? "",
    name: warehouse.name ?? "",
    location: warehouse.location ?? "",
    isDefault: warehouse.is_default,
    isActive: warehouse.is_active,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

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
      await api.patch(`${SCM}/inventory/warehouses/${warehouse.id}`, {
        code: form.code.trim(),
        name: form.name.trim(),
        location: form.location,
        isDefault: form.isDefault,
        isActive: form.isActive,
      });
      toast.success("Warehouse updated");
      onSaved();
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(msg.includes("duplicate_code") ? "That code already exists" : "Failed to update warehouse");
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
      title={`Edit ${warehouse.code}`}
      subtitle="Update the stock location."
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
        <Field label="Code" required>
          <Input value={form.code} onChange={(v) => set("code", v)} />
        </Field>
        <Field label="Name" required>
          <Input value={form.name} onChange={(v) => set("name", v)} />
        </Field>
        <Field label="Location">
          <Input value={form.location} onChange={(v) => set("location", v)} placeholder="Address / area" />
        </Field>
        <Checkbox
          label="Default warehouse"
          checked={form.isDefault}
          onChange={(v) => set("isDefault", v)}
        />
        <Checkbox label="Active" checked={form.isActive} onChange={(v) => set("isActive", v)} />
      </div>
    </Panel>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-border text-accent focus:ring-2 focus:ring-accent/20"
      />
      {label}
    </label>
  );
}
