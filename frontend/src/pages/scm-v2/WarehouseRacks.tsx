// ----------------------------------------------------------------------------
// WarehouseRacks — desktop Racks & Bins page (feat/desktop-rack-management).
//
// The rack-CREATION surface used to exist ONLY on mobile (MobileModuleList's
// FORM_WAREHOUSE "Rack" form → POST /warehouse/racks). Desktop never got a
// page, so the GRN per-line Rack picker showed "No racks in this warehouse"
// with no way to add one from a desktop. This is that page.
//
// It mirrors the mobile "Rack" create form (warehouseId + rack label + position
// + notes) and adds a desktop-only "Seed N racks" quick-add (POST with
// { warehouseId, count, prefix }). Per-row edit (PATCH) + delete (DELETE, only
// when the rack is empty — enforced by the backend and gated in the UI).
//
// Reads: useWarehouses() for the selector, useRacks({ warehouseId }) for the
// grid + KPI summary. The selected warehouse lives in the URL (?warehouseId=)
// so the view is shareable / reload-stable.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, Plus, Layers } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import {
  useRacks,
  useCreateRack,
  useUpdateRack,
  useDeleteRack,
  type Rack,
  type RackStatus,
} from '../../vendor/scm/lib/warehouse-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import styles from './Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const STATUS_LABEL: Record<RackStatus, string> = {
  OCCUPIED: 'Occupied',
  RESERVED: 'Reserved',
  EMPTY: 'Empty',
};

export const WarehouseRacks = () => {
  const [params, setParams] = useSearchParams();
  const warehouses = useWarehouses();
  const warehouseId = params.get('warehouseId') ?? '';

  // Default to the first warehouse once the list loads (keeps the URL as state).
  useEffect(() => {
    if (!warehouseId && (warehouses.data?.length ?? 0) > 0) {
      const first = warehouses.data![0];
      const p = new URLSearchParams(params);
      p.set('warehouseId', first.id);
      setParams(p, { replace: true });
    }
  }, [warehouseId, warehouses.data, params, setParams]);

  const selectWarehouse = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('warehouseId', id);
    setParams(p, { replace: true });
  };

  const racks = useRacks(warehouseId ? { warehouseId } : undefined);
  const [editing, setEditing] = useState<Rack | null>(null);
  // Which create surface is open: the single-rack drawer, the seed modal, or none.
  const [creatingMode, setCreatingMode] = useState<'single' | 'seed' | null>(null);

  const del = useDeleteRack();
  const notify = useNotify();
  const confirm = useConfirm();

  const summary = racks.data?.summary;

  const removeRack = async (rack: Rack) => {
    if ((rack.items?.length ?? 0) > 0) {
      notify({ title: 'This rack still has stock on it.', body: 'Move or stock out its items before deleting.', tone: 'error' });
      return;
    }
    const ok = await confirm({
      title: `Delete ${rack.rack}?`,
      body: 'This removes the empty rack. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    del.mutate(rack.id, {
      onError: (e) => notify({ title: 'Could not delete rack', body: (e as Error).message, tone: 'error' }),
    });
  };

  const columns = useMemo<DataGridColumn<Rack>[]>(() => [
    {
      key: 'rack',
      label: 'Rack',
      width: 160,
      accessor: (r) => <span className={styles.codeChip}>{r.rack}</span>,
      searchValue: (r) => r.rack,
      filterValue: (r) => r.rack,
      sortFn: (a, b) => (a.rack ?? '').localeCompare(b.rack ?? '', undefined, { numeric: true }),
    },
    {
      key: 'position',
      label: 'Position',
      width: 160,
      accessor: (r) => r.position ?? '—',
      searchValue: (r) => r.position ?? '',
    },
    {
      key: 'status',
      label: 'Status',
      width: 120,
      accessor: (r) => (
        <span className={`${styles.statusPill} ${
          r.status === 'OCCUPIED' ? styles.statusActive
            : r.status === 'RESERVED' ? styles.statusBlocked
            : styles.statusInactive
        }`}>
          {STATUS_LABEL[r.status]}
        </span>
      ),
      searchValue: (r) => STATUS_LABEL[r.status],
      filterValue: (r) => STATUS_LABEL[r.status],
      sortFn: (a, b) => a.status.localeCompare(b.status),
    },
    {
      key: 'items',
      label: 'Items',
      width: 90,
      align: 'right',
      accessor: (r) => r.items?.length ?? 0,
      sortFn: (a, b) => (a.items?.length ?? 0) - (b.items?.length ?? 0),
      searchValue: (r) => String(r.items?.length ?? 0),
    },
    {
      key: 'notes',
      label: 'Notes',
      width: 240,
      accessor: (r) => r.notes ?? '—',
      searchValue: (r) => r.notes ?? '',
    },
    {
      key: 'actions',
      label: '',
      width: 130,
      align: 'right',
      sortable: false,
      groupable: false,
      accessor: (r) => (
        <span onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" onClick={() => setEditing(r)}>Edit</Button>
          <Button variant="ghost" size="sm" onClick={() => removeRack(r)} disabled={(r.items?.length ?? 0) > 0}>Delete</Button>
        </span>
      ),
      searchValue: () => '',
    },
    // removeRack is stable enough for this page; deps intentionally minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Racks &amp; Bins</h1>
          <Link to="/scm/warehouses" className={styles.subtitle} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}>
            <ArrowLeft size={12} strokeWidth={1.75} /> Back to Warehouses
          </Link>
        </div>
        <div className={styles.actionsRow}>
          <Button variant="ghost" size="md" onClick={() => { setEditing(null); setCreatingMode('seed'); }} disabled={!warehouseId}>
            <Layers {...ICON} />
            <span>Seed racks</span>
          </Button>
          <Button variant="primary" size="md" onClick={() => { setEditing(null); setCreatingMode('single'); }} disabled={!warehouseId}>
            <Plus {...ICON} />
            <span>New rack</span>
          </Button>
        </div>
      </div>

      <div className={styles.headerRow}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-12)' }}>
          <span className={styles.eyebrow} style={{ margin: 0 }}>Warehouse</span>
          <span className={styles.selectWrap} style={{ minWidth: 240 }}>
            <select
              className={styles.fieldSelect}
              value={warehouseId}
              onChange={(e) => selectWarehouse(e.target.value)}
            >
              {(warehouses.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
              ))}
            </select>
            <ChevronDown className={styles.selectChevron} size={14} strokeWidth={1.75} />
          </span>
        </label>

        {summary && (
          <div style={{ display: 'inline-flex', gap: 'var(--space-4)', flexWrap: 'wrap', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            <span>Total <strong style={{ color: 'var(--c-ink)' }}>{summary.total}</strong></span>
            <span>Occupied <strong style={{ color: 'var(--c-ink)' }}>{summary.occupied}</strong></span>
            <span>Empty <strong style={{ color: 'var(--c-ink)' }}>{summary.empty}</strong></span>
            <span>Reserved <strong style={{ color: 'var(--c-ink)' }}>{summary.reserved}</strong></span>
            <span>Occupancy <strong style={{ color: 'var(--c-ink)' }}>{summary.occupancyRate}%</strong></span>
          </div>
        )}
      </div>

      <DataGrid
        rows={racks.data?.racks ?? []}
        columns={columns}
        storageKey="dg-warehouse-racks"
        rowKey={(r) => r.id}
        searchPlaceholder="Search racks…"
        groupBanner={false}
        isLoading={racks.isLoading}
        emptyMessage={warehouseId ? 'No racks in this warehouse yet. Add one with New rack.' : 'Select a warehouse to view its racks.'}
      />

      {(creatingMode === 'single' || editing) && warehouseId && (
        <RackFormDrawer
          warehouseId={warehouseId}
          editing={editing}
          onClose={() => { setCreatingMode(null); setEditing(null); }}
        />
      )}

      {creatingMode === 'seed' && warehouseId && (
        <SeedRacksModal
          warehouseId={warehouseId}
          onClose={() => setCreatingMode(null)}
        />
      )}
    </div>
  );
};

/* ── Single-rack create / edit drawer — mirrors the mobile "Rack" form ──── */
function RackFormDrawer({
  warehouseId, editing, onClose,
}: {
  warehouseId: string;
  editing: Rack | null;
  onClose: () => void;
}) {
  const create = useCreateRack();
  const update = useUpdateRack();
  const notify = useNotify();
  const [form, setForm] = useState({
    rack: editing?.rack ?? '',
    position: editing?.position ?? '',
    notes: editing?.notes ?? '',
    reserved: editing?.reserved ?? false,
  });

  const submit = () => {
    if (!form.rack.trim()) {
      notify({ title: 'A rack label is required.', tone: 'error' });
      return;
    }
    const onError = (e: unknown) => notify({ title: 'Could not save rack', body: (e as Error).message, tone: 'error' });
    if (editing) {
      update.mutate(
        { id: editing.id, rack: form.rack.trim(), position: form.position, notes: form.notes, reserved: form.reserved },
        { onSuccess: onClose, onError },
      );
    } else {
      create.mutate(
        { warehouseId, rack: form.rack.trim(), position: form.position || undefined, notes: form.notes || undefined, reserved: form.reserved },
        { onSuccess: onClose, onError },
      );
    }
  };

  const busy = create.isPending || update.isPending;

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>{editing ? 'Edit Rack' : 'New Rack'}</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}>Close</button>
        </div>
        <div className={styles.drawerBody}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Rack Label *</span>
            <input className={styles.fieldInput} value={form.rack} placeholder="e.g. Rack A1"
              onChange={(e) => setForm((s) => ({ ...s, rack: e.target.value }))} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Position</span>
            <input className={styles.fieldInput} value={form.position ?? ''} placeholder="Aisle / bay / level"
              onChange={(e) => setForm((s) => ({ ...s, position: e.target.value }))} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Notes</span>
            <textarea className={styles.fieldTextarea} value={form.notes ?? ''}
              onChange={(e) => setForm((s) => ({ ...s, notes: e.target.value }))} />
          </label>
          <label className={styles.fieldRow}>
            <input type="checkbox" checked={form.reserved}
              onChange={(e) => setForm((s) => ({ ...s, reserved: e.target.checked }))} />
            <span className={styles.fieldLabel} style={{ textTransform: 'none' }}>Reserve this rack (hold empty)</span>
          </label>
        </div>
        <div className={styles.drawerFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Seed N racks quick-add (desktop-only) — POST { warehouseId, count, prefix } */
function SeedRacksModal({
  warehouseId, onClose,
}: {
  warehouseId: string;
  onClose: () => void;
}) {
  const create = useCreateRack();
  const notify = useNotify();
  const [prefix, setPrefix] = useState('Rack');
  const [count, setCount] = useState(10);

  const submit = () => {
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n < 1) {
      notify({ title: 'Enter how many racks to create (1–200).', tone: 'error' });
      return;
    }
    create.mutate(
      { warehouseId, count: n, prefix: prefix.trim() || 'Rack' },
      {
        onSuccess: (res) => {
          const made = res.created ?? res.racks?.length ?? 0;
          notify({ title: made > 0 ? `Created ${made} rack${made === 1 ? '' : 's'}.` : 'No new racks — those labels already exist.' });
          onClose();
        },
        onError: (e) => notify({ title: 'Could not seed racks', body: (e as Error).message, tone: 'error' }),
      },
    );
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>Seed Racks</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}>Close</button>
        </div>
        <div className={styles.modalBody}>
          <p className={styles.subtitle} style={{ margin: 0 }}>
            Quickly create numbered racks (e.g. Rack 1 … Rack {Math.max(1, Math.floor(Number(count) || 0))}). Labels that already exist are skipped. Max 200 at a time.
          </p>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Prefix</span>
            <input className={styles.fieldInput} value={prefix} placeholder="Rack"
              onChange={(e) => setPrefix(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>How many</span>
            <input className={styles.fieldInput} type="number" min={1} max={200} value={count}
              onChange={(e) => setCount(Number(e.target.value))} />
          </label>
        </div>
        <div className={styles.drawerFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create racks'}
          </Button>
        </div>
      </div>
    </div>
  );
}
