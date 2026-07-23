// ----------------------------------------------------------------------------
// WarehouseFormDrawer — shared create/edit warehouse form.
//
// Extracted from pages/scm-v2/Warehouses.tsx so the SAME form can be opened
// from more than one place (the Warehouses master page today; a Racks & Bins
// page later, which groups racks by warehouse, so creating a warehouse there
// is the natural entry point). onSaved fires after a successful create/update
// so a caller that reads warehouses from a different query can refetch.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useCreateWarehouse,
  useUpdateWarehouse,
  type Warehouse,
  type WarehouseType,
} from '../lib/inventory-queries';
import {
  useLocalities,
  distinctCountries,
  statesInCountry,
  citiesInState,
  postcodesInCity,
  countryForState,
} from '../lib/localities-queries';
import { useNotify } from './NotifyDialog';
import styles from '../../../pages/scm-v2/Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* Ordered for the dropdown — most-used first. Labels are the display text, the
   value is the enum literal stored in scm.warehouses.type (mig 0171). */
const TYPE_OPTIONS: { value: WarehouseType; label: string }[] = [
  { value: 'warehouse', label: 'Warehouse (stock)' },
  { value: 'showroom',  label: 'Showroom (sales + venue)' },
  { value: 'display',   label: 'Display (partner display stock)' },
  { value: 'service',   label: 'Service centre' },
  { value: 'others',    label: 'Others (HQ, etc.)' },
];

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
  /* Derive the initial type from either the stored `type` (mig 0171) or the
     legacy is_showroom flag — a pre-migration edit still opens with a coherent
     choice. Default 'warehouse' for a fresh create. */
  const initialType: WarehouseType =
    editing?.type ?? (editing?.is_showroom ? 'showroom' : 'warehouse');
  const [form, setForm] = useState({
    code: editing?.code ?? '',
    name: editing?.name ?? '',
    location: editing?.location ?? '',
    country: editing?.country ?? '',
    state: editing?.state ?? '',
    city: editing?.city ?? '',
    postcode: editing?.postcode ?? '',
    isActive: editing?.is_active ?? true,
    isDefault: editing?.is_default ?? false,
    type: initialType,
    venueName: editing?.venue_name ?? '',
  });

  /* Country / State / City / Postcode cascade off scm.my_localities — same
     source the SO Maintenance geo table maintains. Country picked first
     (defaults to Malaysia when unset); State picker is filtered by country;
     picking State auto-derives Country if it was blank so the operator
     doesn't have to reselect. Empty locality set (unseeded) → the state
     dropdown gracefully renders empty free-text so nothing breaks. */
  const localities = useLocalities();
  const localityRows = localities.data ?? [];
  const countries = useMemo(() => distinctCountries(localityRows), [localityRows]);
  const states = useMemo(
    () => statesInCountry(localityRows, form.country),
    [localityRows, form.country],
  );
  const cities = useMemo(
    () => (form.state ? citiesInState(localityRows, form.state) : []),
    [localityRows, form.state],
  );
  const postcodes = useMemo(
    () => (form.state && form.city ? postcodesInCity(localityRows, form.state, form.city) : []),
    [localityRows, form.state, form.city],
  );

  /* When the operator picks a State, back-derive Country from my_localities
     if the current Country is blank OR disagrees. This makes the linkage
     the owner asked for: pick State, Country auto-fills. */
  const pickState = (nextState: string) => {
    const derived = countryForState(localityRows, nextState);
    setForm((s) => ({
      ...s,
      state: nextState,
      country: derived ?? s.country,
      city: '',
      postcode: '',
    }));
  };

  const done = () => { onSaved?.(); onClose(); };

  const submit = () => {
    if (!form.code.trim() || !form.name.trim()) {
      notify({ title: 'Code and Name are required.', tone: 'error' });
      return;
    }
    /* Block the half-configured showroom at the point of creation. A warehouse
       classified as Showroom with no Venue name is not an error the database
       can see — it simply resolves to NO venue, so every order from every
       salesperson parked under it silently carries a blank venue. Catching it
       here, while someone is looking at the form, is the only cheap moment. */
    const isShowroom = form.type === 'showroom';
    if (isShowroom && !form.venueName.trim()) {
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
        country: form.country || null,
        state: form.state || null,
        city: form.city || null,
        postcode: form.postcode || null,
        isActive: form.isActive,
        isDefault: form.isDefault,
        type: form.type,
        venueName: isShowroom ? form.venueName.trim() : null,
      }, { onSuccess: done });
    } else {
      create.mutate({
        code: form.code,
        name: form.name,
        location: form.location || undefined,
        country: form.country || null,
        state: form.state || null,
        city: form.city || null,
        postcode: form.postcode || null,
        isDefault: form.isDefault,
        type: form.type,
        venueName: isShowroom ? form.venueName.trim() : null,
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
            <div className={styles.eyebrow}>Street / area</div>
            <input className={styles.searchInput} style={{ width: '100%' }}
              value={form.location ?? ''} placeholder="e.g. No. 12, Jalan …"
              onChange={(e) => setForm((s) => ({ ...s, location: e.target.value }))} />
          </label>
          {/* ── Structured address (mig 0180) ────────────────────────────
              Country → State → City → Postcode cascade — canonical from
              scm.my_localities (same source SO Maintenance's Geo table
              maintains). Country picked first filters the state dropdown;
              picking State also back-derives Country if it was blank so
              the operator doesn't reselect. Locality dataset empty (cold-
              start) → the pickers gracefully fall back to free-text. */}
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Country</div>
            {countries.length > 0 ? (
              <select className={styles.searchInput} style={{ width: '100%' }}
                value={form.country ?? ''}
                onChange={(e) => setForm((s) => ({ ...s, country: e.target.value, state: '', city: '', postcode: '' }))}
              >
                <option value="">— pick country —</option>
                {form.country && !countries.includes(form.country) && (
                  <option value={form.country}>{form.country} (legacy)</option>
                )}
                {countries.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : (
              <input className={styles.searchInput} style={{ width: '100%' }}
                value={form.country ?? ''} placeholder="e.g. Malaysia"
                onChange={(e) => setForm((s) => ({ ...s, country: e.target.value }))} />
            )}
          </label>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>State</div>
            {states.length > 0 ? (
              <select className={styles.searchInput} style={{ width: '100%' }}
                value={form.state ?? ''}
                onChange={(e) => pickState(e.target.value)}
              >
                <option value="">— pick state —</option>
                {form.state && !states.includes(form.state) && (
                  <option value={form.state}>{form.state} (legacy)</option>
                )}
                {states.map((st) => <option key={st} value={st}>{st}</option>)}
              </select>
            ) : (
              <input className={styles.searchInput} style={{ width: '100%' }}
                value={form.state ?? ''} placeholder="e.g. Kuala Lumpur"
                onChange={(e) => setForm((s) => ({ ...s, state: e.target.value }))} />
            )}
          </label>
          {form.state && (
            <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
              <div className={styles.eyebrow}>City</div>
              {cities.length > 0 ? (
                <select className={styles.searchInput} style={{ width: '100%' }}
                  value={form.city ?? ''}
                  onChange={(e) => setForm((s) => ({ ...s, city: e.target.value, postcode: '' }))}
                >
                  <option value="">— pick city —</option>
                  {form.city && !cities.includes(form.city) && (
                    <option value={form.city}>{form.city} (legacy)</option>
                  )}
                  {cities.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input className={styles.searchInput} style={{ width: '100%' }}
                  value={form.city ?? ''} placeholder="e.g. Cheras"
                  onChange={(e) => setForm((s) => ({ ...s, city: e.target.value }))} />
              )}
            </label>
          )}
          {form.state && form.city && (
            <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
              <div className={styles.eyebrow}>Postcode</div>
              {postcodes.length > 0 ? (
                <select className={styles.searchInput} style={{ width: '100%' }}
                  value={form.postcode ?? ''}
                  onChange={(e) => setForm((s) => ({ ...s, postcode: e.target.value }))}
                >
                  <option value="">— pick postcode —</option>
                  {form.postcode && !postcodes.includes(form.postcode) && (
                    <option value={form.postcode}>{form.postcode} (legacy)</option>
                  )}
                  {postcodes.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              ) : (
                <input className={styles.searchInput} style={{ width: '100%' }}
                  value={form.postcode ?? ''} placeholder="e.g. 56000" inputMode="numeric"
                  onChange={(e) => setForm((s) => ({ ...s, postcode: e.target.value }))} />
              )}
            </label>
          )}
          {/* ── Type (mig 0171) ───────────────────────────────────────────
              5-bucket classification: warehouse / showroom / display / service
              / others. Owner 2026-07-22: SO reports and delivery routing bucket
              by this, so it must be picked here (not derived from the code). */}
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Type *</div>
            <select className={styles.searchInput} style={{ width: '100%' }}
              value={form.type}
              onChange={(e) => setForm((s) => ({ ...s, type: e.target.value as WarehouseType }))}
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          {form.type === 'showroom' && (
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
