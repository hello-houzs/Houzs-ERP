// ----------------------------------------------------------------------------
// NewDpOrderDrawer — create a DP Order (delivery-planning job) from the board.
//
// Owner mockup 2026-07-18. Six job types via a dropdown (owner: "做成 dropdown
// 比较省空间"). Each type's party comes from a different master; the operator may
// give a SOURCE reference (SO no / supplier id / project id / service case id) and
// the SERVER auto-fills the party from it, or fill the fields by hand for a manual
// job (setup / dismantle). Manual fields sent here WIN over the server auto-fill.
//
// Mirrors DeliveryFieldsDrawer's chrome + the Suppliers CSS module. In-app
// NotifyDialog only. Live auto-fill PREVIEW (fetch the master to prefill before
// create) is a follow-up — today the server fills on create and overrides win.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useCreateDpOrder, type DpOrderCreate } from '../lib/delivery-planning-queries';
import { useNotify } from './NotifyDialog';
import styles from '../../../pages/scm-v2/Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const JOB_TYPES: DpOrderCreate['jobType'][] = [
  'DELIVERY', 'PICKUP', 'SERVICE', 'SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP',
];
const JOB_LABEL: Record<DpOrderCreate['jobType'], string> = {
  DELIVERY: 'Delivery', PICKUP: 'Pickup', SERVICE: 'Service',
  SETUP: 'Setup', DISMANTLE: 'Dismantle', SUPPLIER_PICKUP: 'Supplier pickup',
};

/* What the SOURCE reference means for each type, and the field it maps to. */
function sourceMeta(jobType: DpOrderCreate['jobType']): { label: string; hint: string; kind: 'so' | 'supplier' | 'project' | 'assr' | 'none' } {
  switch (jobType) {
    case 'SUPPLIER_PICKUP': return { label: 'Supplier', hint: 'supplier id — party auto-fills from the supplier master', kind: 'supplier' };
    case 'SETUP':
    case 'DISMANTLE': return { label: 'Project / venue', hint: 'PMS project id — venue + PIC auto-fill', kind: 'project' };
    case 'SERVICE': return { label: 'Service case', hint: 'service case id — customer auto-fills', kind: 'assr' };
    default: return { label: 'Sales order', hint: 'SO No. — customer auto-fills (optional)', kind: 'so' };
  }
}

export const NewDpOrderDrawer = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateDpOrder();
  const notify = useNotify();

  const [form, setForm] = useState({
    jobType: 'DELIVERY' as DpOrderCreate['jobType'],
    source: '',
    partyName: '', contactName: '', contactPhone: '',
    address1: '', address2: '', address3: '', address4: '',
    city: '', postcode: '', state: '',
    requestedDate: '', remark: '',
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const src = sourceMeta(form.jobType);

  const submit = () => {
    const body: DpOrderCreate = { jobType: form.jobType };
    const ref = form.source.trim();
    if (ref) {
      if (src.kind === 'supplier') body.supplierId = ref;
      else if (src.kind === 'project') body.projectId = Number(ref) || undefined;
      else if (src.kind === 'assr') body.assrCaseId = Number(ref) || undefined;
      else if (src.kind === 'so') body.soDocNo = ref;
    }
    if (form.requestedDate) body.requestedDate = form.requestedDate;
    if (form.remark.trim()) body.remark = form.remark.trim();

    // Manual fields → overrides (win over the server's auto-fill). Only non-empty
    // keys, so a blank field never clobbers an auto-filled value.
    const ov: Record<string, string | null> = {};
    const map: Array<[keyof typeof form, string]> = [
      ['partyName', 'party_name'], ['contactName', 'contact_name'], ['contactPhone', 'contact_phone'],
      ['address1', 'address1'], ['address2', 'address2'], ['address3', 'address3'], ['address4', 'address4'],
      ['city', 'city'], ['postcode', 'postcode'], ['state', 'state'],
    ];
    for (const [fk, col] of map) {
      const v = String(form[fk] ?? '').trim();
      if (v) ov[col] = v;
    }
    if (Object.keys(ov).length) body.overrides = ov;

    create.mutate(body, {
      onSuccess: () => { notify({ title: 'DP Order created', body: 'It is now on the board as Pending Schedule.' }); onClose(); },
      onError: (err) => notify({ title: 'Create failed', body: err instanceof Error ? err.message : String(err), tone: 'error' }),
    });
  };

  const fieldRow: CSSProperties = { display: 'block', marginBottom: 'var(--space-3)' };
  const inputStyle: CSSProperties = { width: '100%' };
  const row2: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>New DP Order</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}><X {...ICON} /></button>
        </div>

        <div className={styles.drawerBody}>
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Job type</div>
            <select className={styles.searchInput} style={inputStyle}
              value={form.jobType} onChange={(e) => set('jobType', e.target.value as DpOrderCreate['jobType'])}>
              {JOB_TYPES.map((t) => <option key={t} value={t}>{JOB_LABEL[t]}</option>)}
            </select>
          </label>

          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>{src.label} <span style={{ textTransform: 'none', color: 'var(--c-muted, #767b6e)' }}>— optional</span></div>
            <input className={styles.searchInput} style={inputStyle} placeholder={src.hint}
              value={form.source} onChange={(e) => set('source', e.target.value)} />
          </label>

          <div className={styles.eyebrow} style={{ margin: 'var(--space-2) 0', color: 'var(--c-burnt)' }}>
            Party — auto-fills from the {src.label.toLowerCase()}; edit any field to override
          </div>
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>{src.kind === 'supplier' ? 'Supplier' : src.kind === 'project' ? 'Venue' : 'Customer'} name</div>
            <input className={styles.searchInput} style={inputStyle} value={form.partyName} onChange={(e) => set('partyName', e.target.value)} />
          </label>
          <div style={row2}>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Contact</div>
              <input className={styles.searchInput} style={inputStyle} value={form.contactName} onChange={(e) => set('contactName', e.target.value)} />
            </label>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Phone</div>
              <input className={styles.searchInput} style={inputStyle} value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
            </label>
          </div>

          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Address line 1</div>
            <input className={styles.searchInput} style={inputStyle} value={form.address1} onChange={(e) => set('address1', e.target.value)} />
          </label>
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Address line 2</div>
            <input className={styles.searchInput} style={inputStyle} value={form.address2} onChange={(e) => set('address2', e.target.value)} />
          </label>
          <div style={row2}>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>City</div>
              <input className={styles.searchInput} style={inputStyle} value={form.city} onChange={(e) => set('city', e.target.value)} />
            </label>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Postcode</div>
              <input className={styles.searchInput} style={inputStyle} value={form.postcode} onChange={(e) => set('postcode', e.target.value)} />
            </label>
          </div>
          <div style={row2}>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>State</div>
              <input className={styles.searchInput} style={inputStyle} value={form.state} onChange={(e) => set('state', e.target.value)} />
            </label>
            <label style={fieldRow}>
              <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Requested date</div>
              <input type="date" className={styles.searchInput} style={inputStyle} value={form.requestedDate} onChange={(e) => set('requestedDate', e.target.value)} />
            </label>
          </div>
          <label style={fieldRow}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Remark</div>
            <input className={styles.searchInput} style={inputStyle} value={form.remark} onChange={(e) => set('remark', e.target.value)} />
          </label>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create DP Order'}
          </Button>
        </div>
      </div>
    </div>
  );
};
