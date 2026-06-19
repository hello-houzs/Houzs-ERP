// ----------------------------------------------------------------------------
// StateWarehouseEditor — Maintenance tab body for the state → warehouse routing
// table (which physical warehouse fulfils orders shipping to a given state).
// Self-contained: fetches its own mappings + the warehouse master for the picker.
//
// API — backend/src/scm/routes/state-warehouse-mappings.ts, /api/scm/state-warehouse-mappings:
//   GET    /          -> { mappings: Mapping[] }   (every authed staff role)
//   PUT    /:state     -> { mapping }              body { warehouseId, notes }
//   DELETE /:state     -> { ok: true }
// Warehouse picker — GET /api/scm/inventory/warehouses -> { warehouses }.
//
// Full CRUD. State is the natural key (PUT upserts by :state, DELETE clears it).
// The mapping row's warehouse fields come pre-joined (camelCase from the route);
// we still dual-read camelCase ?? snake_case per the repo-wide pg trap.
// No naked edits — explicit Save (PUT). Delete routes through useDialog().confirm.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "../../../components/Button";
import { DataTable, type Column } from "../../../components/DataTable";
import { Panel } from "../../../components/Panel";
import { useQuery } from "../../../hooks/useQuery";
import { useToast } from "../../../hooks/useToast";
import { useDialog } from "../../../hooks/useDialog";
import { api } from "../../../api/client";
import { SCM } from "../../../lib/scm";
import { Field, Input } from "../Suppliers";

// The 16 Malaysian states/territories (mirrors MY_STATES used elsewhere in the
// app). A state already mapped is excluded from the "Add" picker; editing keeps
// the existing state locked (it's the key).
const MY_STATES = [
  "JOHOR", "KEDAH", "KELANTAN", "KL", "LABUAN", "MELAKA",
  "NEGERI SEMBILAN", "PAHANG", "PENANG", "PERAK", "PERLIS",
  "PUTRAJAYA", "SABAH", "SARAWAK", "SELANGOR", "TERENGGANU",
] as const;

interface MappingApi {
  id: string;
  state: string;
  warehouseId?: string | null;
  warehouse_id?: string | null;
  notes: string | null;
  warehouse?: { id: string; code: string; name: string } | null;
  updatedAt?: string | null;
  updated_at?: string | null;
}

interface Mapping {
  id: string;
  state: string;
  warehouseId: string | null;
  notes: string;
  warehouse: { id: string; code: string; name: string } | null;
  updatedAt: string | null;
}

function normalize(r: MappingApi): Mapping {
  return {
    id: r.id,
    state: r.state,
    warehouseId: r.warehouseId ?? r.warehouse_id ?? null,
    notes: r.notes ?? "",
    warehouse: r.warehouse ?? null,
    updatedAt: r.updatedAt ?? r.updated_at ?? null,
  };
}

interface WarehouseApi {
  id: string;
  code: string;
  name: string;
  is_active?: boolean;
  isActive?: boolean;
}

export function StateWarehouseEditor() {
  const toast = useToast();
  const dialog = useDialog();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Mapping | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const list = useQuery<{ mappings: MappingApi[] }>(
    () => api.get(`${SCM}/state-warehouse-mappings`),
    [],
  );
  const warehousesQ = useQuery<{ warehouses: WarehouseApi[] }>(
    () => api.get(`${SCM}/inventory/warehouses`),
    [],
  );

  const rows = list.data ? list.data.mappings.map(normalize) : null;
  const warehouses = warehousesQ.data?.warehouses ?? [];
  const mappedStates = new Set((rows ?? []).map((m) => m.state.toUpperCase()));
  const freeStates = MY_STATES.filter((s) => !mappedStates.has(s));

  async function remove(m: Mapping) {
    const ok = await dialog.confirm({
      title: "Clear mapping",
      message: `Clear the warehouse mapping for ${m.state}? Orders shipping there will fall back to the default routing.`,
      danger: true,
      confirmLabel: "Clear",
    });
    if (!ok) return;
    setDeleting(m.state);
    try {
      await api.del(`${SCM}/state-warehouse-mappings/${encodeURIComponent(m.state)}`);
      toast.success("Mapping cleared");
      list.reload();
    } catch {
      toast.error("Failed to clear mapping");
    } finally {
      setDeleting(null);
    }
  }

  const columns: Column<Mapping>[] = [
    {
      key: "state",
      label: "State",
      render: (m) => <span className="font-semibold text-ink">{m.state}</span>,
      getValue: (m) => m.state,
    },
    {
      key: "warehouse",
      label: "Warehouse",
      render: (m) =>
        m.warehouse ? (
          <span className="text-ink">
            <span className="font-mono text-[12px] text-ink-secondary">{m.warehouse.code}</span>
            <span className="text-ink-muted"> · </span>
            {m.warehouse.name}
          </span>
        ) : (
          <span className="text-ink-muted">Unassigned</span>
        ),
      getValue: (m) => m.warehouse?.name ?? "",
    },
    {
      key: "notes",
      label: "Notes",
      render: (m) => <span className="text-[12px] text-ink-secondary">{m.notes || "—"}</span>,
      getValue: (m) => m.notes,
    },
    {
      key: "_actions",
      label: "",
      align: "right",
      alwaysVisible: true,
      render: (m) => (
        <span className="inline-flex items-center gap-1.5">
          <button
            onClick={() => setEditing(m)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent"
            title="Edit mapping"
          >
            <Pencil size={12} />
            Edit
          </button>
          <button
            onClick={() => void remove(m)}
            disabled={deleting === m.state}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-err/40 bg-surface px-2 text-[11px] font-semibold text-err transition-colors hover:bg-err/5 hover:border-err disabled:opacity-50"
            title="Clear mapping"
          >
            <Trash2 size={12} />
            Clear
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-[12.5px] leading-relaxed text-ink-secondary">
          Routes each delivery state to the warehouse that fulfils its orders. A state with no mapping
          falls back to the default warehouse. State is the key — each state maps to exactly one warehouse.
        </p>
        <Button
          icon={<Plus size={15} />}
          onClick={() => setShowCreate(true)}
          disabled={freeStates.length === 0}
        >
          Add Mapping
        </Button>
      </div>

      <DataTable
        tableId="scm_state_warehouse"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(m) => m.state}
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search state, warehouse, notes…",
        }}
        emptyLabel="No state mappings yet"
        exportName="state-warehouse-mappings"
      />

      {showCreate && (
        <MappingPanel
          mode="create"
          freeStates={[...freeStates]}
          warehouses={warehouses}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            list.reload();
          }}
        />
      )}

      {editing && (
        <MappingPanel
          mode="edit"
          mapping={editing}
          warehouses={warehouses}
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

function MappingPanel({
  mode,
  mapping,
  freeStates = [],
  warehouses,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  mapping?: Mapping;
  freeStates?: string[];
  warehouses: WarehouseApi[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const isEdit = mode === "edit";
  const [state, setState] = useState(mapping?.state ?? freeStates[0] ?? "");
  const [warehouseId, setWarehouseId] = useState(mapping?.warehouseId ?? "");
  const [notes, setNotes] = useState(mapping?.notes ?? "");

  const dirty = isEdit || warehouseId !== "" || notes.trim() !== "";

  async function submit() {
    if (!state) {
      toast.error("Pick a state");
      return;
    }
    setSaving(true);
    try {
      await api.put(`${SCM}/state-warehouse-mappings/${encodeURIComponent(state)}`, {
        warehouseId: warehouseId || null,
        notes: notes.trim() || null,
      });
      toast.success(isEdit ? "Mapping updated" : "Mapping added");
      onSaved();
    } catch {
      toast.error(isEdit ? "Failed to update mapping" : "Failed to add mapping");
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
      title={isEdit ? `Edit ${mapping?.state}` : "Add State Mapping"}
      subtitle="Route a delivery state to its fulfilling warehouse."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Mapping"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="State" required>
          {isEdit ? (
            <div className="flex h-10 items-center rounded-md border border-border bg-surface-dim px-3 text-[13px] font-semibold text-ink-secondary">
              {state}
            </div>
          ) : (
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              {freeStates.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Warehouse">
          <select
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
          >
            <option value="">Unassigned (use default)</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} · {w.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Notes">
          <Input value={notes} onChange={setNotes} placeholder="Optional routing note" />
        </Field>
      </div>
    </Panel>
  );
}
