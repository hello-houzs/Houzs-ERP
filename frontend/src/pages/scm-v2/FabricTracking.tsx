// ----------------------------------------------------------------------------
// Fabric Converter — minimal master view (renamed from Fabric Tracking 2026-05-26).
//
// 5 columns: Fabric Code · Description (editable) · Supplier Code (editable) ·
// Sofa Tier · Bedframe Tier · (delete). Tiers cycle PRICE_1 → 2 → 3 on click.
//
// Commander 2026-05-26 history:
//   • Drop "All Categories" dropdown
//   • Rename from "Fabric Tracking" to "Fabric Converter"
//   • Description must be editable
//   • PR #43 — add "+ New Fabric" + per-row delete (was missing!)
//   • Export CSV / Import CSV (this PR) — round-trip catalog + metric cols via
//     Excel; bulk-upsert by fabric_code instead of one-by-one form entry.
//   • Drop Category select from New Fabric form (still NULL-able in DB).
//
// The table is shared with Products → Maintenance → Fabrics via
// components/FabricsTable.tsx — changes here reflect there automatically.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';
import { Search, Plus, X, Download, Upload } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useFabricTrackings,
  useCreateFabric,
  useBulkUpsertFabrics,
  type FabricTier,
} from '../../vendor/scm/lib/fabric-queries';
import { FabricsTable } from '../../vendor/scm/components/FabricsTable';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { toCsv, parseCsv, triggerDownload, type ParsedImport } from '../../vendor/scm/lib/fabric-csv';
import styles from './FabricTracking.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

export const FabricTracking = () => {
  const notify = useNotify();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [importPreview, setImportPreview] = useState<ParsedImport | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: fabrics, isLoading, error } = useFabricTrackings({
    search: search.trim() || undefined,
  });

  const rows = useMemo(() => fabrics ?? [], [fabrics]);

  // Export: pull the FULL list (ignoring any active search filter — the user
  // would not expect a search-filtered export to round-trip safely on import).
  // Re-fetch unfiltered if a search is active; otherwise reuse `rows`.
  const exportFetch = useFabricTrackings({}).data;
  const onExport = () => {
    const all = (search.trim() ? exportFetch : rows) ?? rows;
    if (all.length === 0) { notify({ title: 'No fabrics to export.', tone: 'error' }); return; }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    triggerDownload(`fabric-converter-${stamp}.csv`, toCsv(all));
  };

  const onPickFile = () => fileInputRef.current?.click();
  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';  // reset so picking same file again re-fires onChange
    if (!file) return;
    const text = await file.text();
    setImportPreview(parseCsv(text));
  };

  return (
    <div className={styles.page}>
      <div className={styles.titleBlock}>
        <h1 className={styles.title}>Fabric Converter</h1>
      </div>

      <div className={styles.filterRow}>
        <div className={styles.searchBox}>
          <Search size={16} strokeWidth={1.75} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search by code or description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="ghost" size="md" onClick={onExport}>
          <Download {...ICON} />
          <span>Export CSV</span>
        </Button>
        <Button variant="ghost" size="md" onClick={onPickFile}>
          <Upload {...ICON} />
          <span>Import CSV</span>
        </Button>
        <Button variant="primary" size="md" onClick={() => setCreating(true)}>
          <Plus {...ICON} />
          <span>New Fabric</span>
        </Button>
        <input ref={fileInputRef} type="file" accept=".csv,text/csv"
          style={{ display: 'none' }} onChange={onFileChosen} />
      </div>

      <FabricsTable rows={rows} isLoading={isLoading} error={error} />

      {creating && <NewFabricDialog onClose={() => setCreating(false)} />}
      {importPreview && (
        <ImportPreviewDialog
          preview={importPreview}
          onClose={() => setImportPreview(null)}
        />
      )}
    </div>
  );
};

const NewFabricDialog = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateFabric();
  const notify = useNotify();
  const [form, setForm] = useState({
    fabricCode: '',
    fabricDescription: '',
    series: '',
    colours: '',
    sofaPriceTier: 'PRICE_2' as FabricTier,
    bedframePriceTier: 'PRICE_2' as FabricTier,
  });

  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    if (!form.fabricCode.trim()) {
      notify({ title: 'Fabric Code is required.', tone: 'error' });
      return;
    }
    const colourList = form.colours.split(',').map((s) => s.trim()).filter(Boolean).map((label) => ({ label }));
    create.mutate({
      fabricCode: form.fabricCode.trim(),
      fabricDescription: form.fabricDescription.trim() || undefined,
      // Owner 2026-06-22 — supplier code IS our code; default it to the fabric
      // code so the column stays populated for CSV round-trip / legacy lookups
      // without asking the user for a separate value.
      supplierCode: form.fabricCode.trim() || undefined,
      series: form.series.trim() || undefined,
      sofaPriceTier: form.sofaPriceTier,
      bedframePriceTier: form.bedframePriceTier,
      // Migration 0124/0125 — also create the POS-pickable fabric_library entry + colours.
      label: form.fabricDescription.trim() || form.fabricCode.trim(),
      colours: colourList,
    }, {
      onSuccess: async (res) => {
        if (res.libraryWarning) {
          await notify({ title: 'Fabric saved, but the customer-pickable entry had an issue:', body: `${res.libraryWarning}` });
        }
        onClose();
      },
      onError: (e) => notify({ title: 'Create failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' }),
    });
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{
          width: 520, maxWidth: '95vw', background: 'var(--c-cream)',
          padding: 'var(--space-5)', borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-3)',
        }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className={styles.title} style={{ fontSize: 'var(--fs-22)' }}>New Fabric</h2>
          <button type="button" className={styles.searchInput} style={{ width: 32, height: 32, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} onClick={onClose}>
            <X {...ICON} />
          </button>
        </div>


        <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginBottom: 4 }}>Fabric Code *</div>
          <input className={styles.searchInput} style={{ width: '100%' }}
            value={form.fabricCode} placeholder="AVANI 09 / AH-2 / NEW-FABRIC-001"
            autoFocus
            onChange={(e) => set('fabricCode', e.target.value)} />
        </label>

        <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginBottom: 4 }}>Description</div>
          <input className={styles.searchInput} style={{ width: '100%' }}
            value={form.fabricDescription} placeholder="e.g. IVORY / FABRIC"
            onChange={(e) => set('fabricDescription', e.target.value)} />
        </label>

        <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginBottom: 4 }}>Series (collection name)</div>
          <input className={styles.searchInput} style={{ width: '100%' }}
            value={form.series} placeholder="e.g. KOONA VELVET H2O"
            onChange={(e) => set('series', e.target.value)} />
        </label>

        <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginBottom: 4 }}>Colours (comma-separated — makes the fabric pickable on POS)</div>
          <input className={styles.searchInput} style={{ width: '100%' }}
            value={form.colours} placeholder="e.g. Sand, Charcoal, Ivory"
            onChange={(e) => set('colours', e.target.value)} />
        </label>

        {/* Commander 2026-05-27 (Fix 6): only Price 1 and Price 2 are in
            commercial use today. PRICE_3 dropped from the dropdown but
            retained in the enum so historical rows still render their
            tier; click-cycle on the table collapses to a 2-state toggle. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
          <label>
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginBottom: 4 }}>Sofa Tier</div>
            <select className={styles.searchInput} style={{ width: '100%' }}
              value={form.sofaPriceTier}
              onChange={(e) => set('sofaPriceTier', e.target.value as FabricTier)}>
              <option value="PRICE_1">Price 1</option>
              <option value="PRICE_2">Price 2</option>
            </select>
          </label>
          <label>
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginBottom: 4 }}>Bedframe Tier</div>
            <select className={styles.searchInput} style={{ width: '100%' }}
              value={form.bedframePriceTier}
              onChange={(e) => set('bedframePriceTier', e.target.value as FabricTier)}>
              <option value="PRICE_1">Price 1</option>
              <option value="PRICE_2">Price 2</option>
            </select>
          </label>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', marginTop: 'var(--space-5)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Create Fabric'}
          </Button>
        </div>
      </div>
    </div>
  );
};

// Import-preview modal: shows row count + any parse warnings/errors before
// the user commits to writing to the DB. Upsert semantics — fabric_code is
// the match key. Existing rows missing from the CSV are NOT deleted.
const ImportPreviewDialog = ({
  preview,
  onClose,
}: {
  preview: ParsedImport;
  onClose: () => void;
}) => {
  const upsert = useBulkUpsertFabrics();
  const notify = useNotify();
  const { rows, errors, warnings } = preview;
  const canCommit = rows.length > 0;

  const commit = () => {
    upsert.mutate(rows, {
      onSuccess: async (res) => {
        const trailing = res.errors.length ? ` (${res.errors.length} row${res.errors.length === 1 ? '' : 's'} rejected server-side)` : '';
        await notify({ title: `Imported ${res.upserted} fabric${res.upserted === 1 ? '' : 's'}.${trailing}` });
        onClose();
      },
      onError: (e) => notify({ title: 'Import failed', body: `${e instanceof Error ? e.message : String(e)}`, tone: 'error' }),
    });
  };

  return (
    <div onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.32)', zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxWidth: '95vw', background: 'var(--c-cream)',
          padding: 'var(--space-5)', borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-3)',
        }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className={styles.title} style={{ fontSize: 'var(--fs-22)' }}>Import CSV</h2>
          <button type="button" className={styles.searchInput} style={{ width: 32, height: 32, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} onClick={onClose}>
            <X {...ICON} />
          </button>
        </div>


        <div style={{ background: 'var(--bg-surface, #fff)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <div style={{ fontSize: 'var(--fs-14)' }}>
            <strong>{rows.length}</strong> row{rows.length === 1 ? '' : 's'} ready to upsert.
          </div>
          {warnings.length > 0 && (
            <div style={{ marginTop: 8, color: 'var(--fg-muted)', fontSize: 'var(--fs-12)' }}>
              {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
          {errors.length > 0 && (
            <div style={{ marginTop: 8, color: 'var(--c-error, #b34)', fontSize: 'var(--fs-12)', maxHeight: 200, overflowY: 'auto' }}>
              {errors.slice(0, 30).map((e, i) => <div key={i}>✗ {e}</div>)}
              {errors.length > 30 && <div>…and {errors.length - 30} more.</div>}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={commit} disabled={!canCommit || upsert.isPending}>
            {upsert.isPending ? 'Importing…' : `Upsert ${rows.length} row${rows.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </div>
  );
};
