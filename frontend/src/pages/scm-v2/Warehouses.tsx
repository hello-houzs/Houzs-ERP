// ----------------------------------------------------------------------------
// Warehouses — CRUD page (PR #37). Manages physical stock locations.
//
// Default seed: KL Warehouse + 2990 PJ (from migration 0050). Add new
// warehouses here; deactivate (don't delete) when retired to preserve
// historical movements + lots.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useWarehouses,
  useCreateWarehouse,
  useUpdateWarehouse,
  type Warehouse,
} from '../../vendor/scm/lib/inventory-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

export const Warehouses = () => {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const warehouses = useWarehouses({ includeInactive });

  /* Shared DataGrid conversion (2026-06-12) — sort / per-column filter /
     column show-hide / reorder / pin / persisted layout. The Edit button
     stopPropagations so it never reads as a row click. */
  const columns = useMemo<DataGridColumn<Warehouse>[]>(() => [
    {
      key: 'code',
      label: 'Code',
      width: 100,
      accessor: (w) => <span className={styles.codeChip}>{w.code}</span>,
      searchValue: (w) => w.code,
      filterValue: (w) => w.code,
      sortFn: (a, b) => a.code.localeCompare(b.code),
    },
    {
      key: 'name',
      label: 'Name',
      width: 200,
      accessor: (w) => w.name,
      sortFn: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'location',
      label: 'Location',
      width: 220,
      accessor: (w) => w.location ?? '—',
    },
    {
      key: 'default',
      label: 'Default',
      width: 110,
      accessor: (w) => (w.is_default ? '★ Default' : '—'),
      filterValue: (w) => (w.is_default ? 'Default' : '—'),
      sortFn: (a, b) => Number(a.is_default) - Number(b.is_default),
    },
    {
      key: 'status',
      label: 'Status',
      width: 110,
      accessor: (w) => (
        <span className={`${styles.statusPill} ${w.is_active ? styles.statusActive : styles.statusInactive}`}>
          {w.is_active ? 'Active' : 'Inactive'}
        </span>
      ),
      searchValue: (w) => (w.is_active ? 'Active' : 'Inactive'),
      filterValue: (w) => (w.is_active ? 'Active' : 'Inactive'),
      sortFn: (a, b) => Number(a.is_active) - Number(b.is_active),
    },
    {
      key: 'actions',
      label: '',
      width: 80,
      align: 'right',
      sortable: false,
      groupable: false,
      accessor: (w) => (
        <span onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" onClick={() => setEditing(w)}>Edit</Button>
        </span>
      ),
      searchValue: () => '',
    },
  ], []);

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.title}>Warehouses</h1>
        </div>
        <Button variant="primary" size="md" onClick={() => setCreating(true)}>
          <Plus {...ICON} />
          <span>New Warehouse</span>
        </Button>
      </div>

      <div className={styles.headerRow}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--fs-13)' }}>
          <input type="checkbox" checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      <DataGrid
        rows={warehouses.data ?? []}
        columns={columns}
        storageKey="dg-warehouses"
        rowKey={(w) => w.id}
        searchPlaceholder="Search warehouses…"
        groupBanner={false}
        isLoading={warehouses.isLoading}
        emptyMessage="No warehouses yet."
      />

      {(creating || editing) && (
        <WarehouseDrawer
          editing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      )}
    </div>
  );
};

const WarehouseDrawer = ({
  editing, onClose,
}: {
  editing: Warehouse | null;
  onClose: () => void;
}) => {
  const create = useCreateWarehouse();
  const update = useUpdateWarehouse();
  const notify = useNotify();
  const [form, setForm] = useState({
    code: editing?.code ?? '',
    name: editing?.name ?? '',
    location: editing?.location ?? '',
    isActive: editing?.is_active ?? true,
    isDefault: editing?.is_default ?? false,
  });

  const submit = () => {
    if (!form.code.trim() || !form.name.trim()) {
      notify({ title: 'Code and Name are required.', tone: 'error' });
      return;
    }
    if (editing) {
      update.mutate({
        id: editing.id,
        code: form.code,
        name: form.name,
        location: form.location,
        isActive: form.isActive,
        isDefault: form.isDefault,
      }, { onSuccess: onClose });
    } else {
      create.mutate({
        code: form.code,
        name: form.name,
        location: form.location || undefined,
        isDefault: form.isDefault,
      }, { onSuccess: onClose });
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>{editing ? 'Edit Warehouse' : 'New Warehouse'}</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}>
            <X {...ICON} />
          </button>
        </div>
        <div className={styles.drawerBody}>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Code *</div>
            <input className={styles.searchInput} style={{ width: '100%' }}
              value={form.code} placeholder="KL / PJ / JB"
              onChange={(e) => setForm((s) => ({ ...s, code: e.target.value.toUpperCase() }))} />
          </label>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Name *</div>
            <input className={styles.searchInput} style={{ width: '100%' }}
              value={form.name} placeholder="KL Warehouse / 2990 PJ"
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} />
          </label>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Location</div>
            <input className={styles.searchInput} style={{ width: '100%' }}
              value={form.location ?? ''} placeholder="Address / area"
              onChange={(e) => setForm((s) => ({ ...s, location: e.target.value }))} />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 'var(--space-4)' }}>
            <input type="checkbox" checked={form.isDefault}
              onChange={(e) => setForm((s) => ({ ...s, isDefault: e.target.checked }))} />
            Default warehouse
          </label>
          {editing && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.isActive}
                onChange={(e) => setForm((s) => ({ ...s, isActive: e.target.checked }))} />
              Active
            </label>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending || update.isPending}>
            {(create.isPending || update.isPending) ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
};
