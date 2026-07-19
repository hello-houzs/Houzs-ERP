// ----------------------------------------------------------------------------
// WarehouseFormDrawer — shared create/edit warehouse form.
//
// Extracted from pages/scm-v2/Warehouses.tsx so the SAME form can be opened
// from more than one place (the Warehouses master page today; a Racks & Bins
// page later, which groups racks by warehouse, so creating a warehouse there
// is the natural entry point). onSaved fires after a successful create/update
// so a caller that reads warehouses from a different query can refetch.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useCreateWarehouse,
  useUpdateWarehouse,
  type Warehouse,
} from '../lib/inventory-queries';
import { useNotify } from './NotifyDialog';
import styles from '../../../pages/scm-v2/Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

export const WarehouseFormDrawer = ({
  editing, onClose, onSaved,
}: {
  editing: Warehouse | null;
  onClose: () => void;
  /** Called after a successful create/update (before onClose). */
  onSaved?: () => void;
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
    isShowroom: editing?.is_showroom ?? false,
    venueName: editing?.venue_name ?? '',
  });

  const done = () => { onSaved?.(); onClose(); };

  const submit = () => {
    if (!form.code.trim() || !form.name.trim()) {
      notify({ title: 'Code and Name are required.', tone: 'error' });
      return;
    }
    /* Block the half-configured showroom at the point of creation. A warehouse
       flagged as a Showroom with no Venue name is not an error the database can
       see — it simply resolves to NO venue, so every order from every
       salesperson parked under it silently carries a blank venue. Catching it
       here, while someone is looking at the form, is the only cheap moment. */
    if (form.isShowroom && !form.venueName.trim()) {
      notify({
        title: 'A Showroom needs a Venue name.',
        body: 'Sales orders raised by salespeople parked under this showroom will be attributed to this venue.',
        tone: 'error',
      });
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
        isShowroom: form.isShowroom,
        venueName: form.isShowroom ? form.venueName.trim() : null,
      }, { onSuccess: done });
    } else {
      create.mutate({
        code: form.code,
        name: form.name,
        location: form.location || undefined,
        isDefault: form.isDefault,
        isShowroom: form.isShowroom,
        venueName: form.isShowroom ? form.venueName.trim() : null,
      }, { onSuccess: done });
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
          {/* ── Showroom (owner 2026-07-19) ────────────────────────────────
              Marking a warehouse as a Showroom is a VENUE decision, not a stock
              one, so the Venue name sits directly under the flag rather than in
              a separate screen — the two are meaningless apart. */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--space-2)' }}>
            <input type="checkbox" checked={form.isShowroom}
              onChange={(e) => setForm((s) => ({ ...s, isShowroom: e.target.checked }))} />
            Mark as Showroom
          </label>
          {form.isShowroom && (
            <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
              <div className={styles.eyebrow}>Venue name *</div>
              <input className={styles.searchInput} style={{ width: '100%' }}
                value={form.venueName} placeholder="Kuala Lumpur Showroom"
                onChange={(e) => setForm((s) => ({ ...s, venueName: e.target.value }))} />
              <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
                Sales orders raised by salespeople parked under this showroom
                default to this venue. It also appears in the Sales Maintenance
                venue list.
              </div>
            </label>
          )}
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
