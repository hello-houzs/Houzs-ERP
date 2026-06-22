// ----------------------------------------------------------------------------
// StockTransferNew — full-page form at /inventory/transfers/new.
//
// Mirrors PurchaseOrderNew chrome: back link + title + Cancel/Save in the
// headerRow, header card with From/To/Date/Notes, items grid below with
// SKU picker + live current-balance lookup against the From warehouse.
// PR-DRAFT-removal (2026-05-27): Save creates as POSTED directly + writes
// inventory_movements inline; routes to /inventory/transfers/:id afterward.
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/StockTransferNew.tsx.
// Import boundary only: react-router → react-router-dom; ConfirmDialog/
// NotifyDialog + useWarehouses ← vendored; balances/transfer hooks ←
// vendored stock-queries; mfg-products-queries via vendored slice; css
// colocated. Back/Cancel → list, Save → /scm/stock-transfers/:id.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Save, X, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { useInventoryBalances } from '../../vendor/scm/lib/stock-queries';
import { useMfgProducts } from '../../vendor/scm/lib/mfg-products-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import {
  useCreateStockTransfer,
  type StockTransferItemInput,
} from '../../vendor/scm/lib/stock-queries';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

type LineDraft = StockTransferItemInput & { _key: string };

const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const blankLine = (): LineDraft => ({
  _key: newKey(),
  productCode: '',
  productName: '',
  qty: 1,
  notes: '',
});

const todayISO = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const StockTransferNew = () => {
  const navigate = useNavigate();
  const create   = useCreateStockTransfer();

  const askConfirm = useConfirm();
  const notify = useNotify();

  // ── Header state ─────────────────────────────────────────────────────
  const [fromWarehouseId, setFromWarehouseId] = useState<string>('');
  const [toWarehouseId,   setToWarehouseId]   = useState<string>('');
  const [transferDate,    setTransferDate]    = useState<string>(todayISO());
  const [notes,           setNotes]           = useState<string>('');

  // ── Lines ────────────────────────────────────────────────────────────
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);

  // ── Data ─────────────────────────────────────────────────────────────
  const warehouses = useWarehouses();
  const allSkus    = useMfgProducts();
  // Pull balances for the From warehouse so we can show "available" inline.
  const balances   = useInventoryBalances({
    warehouseId: fromWarehouseId || undefined,
    showAll:     true,
  });
  const balanceMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of (balances.data?.balances ?? [])) {
      m.set(b.product_code, b.qty);
    }
    return m;
  }, [balances.data]);

  // ── Helpers ──────────────────────────────────────────────────────────
  const skuByCode = useMemo(
    () => new Map((allSkus.data ?? []).map((p) => [p.code, p])),
    [allSkus.data],
  );

  const setLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((cur) => cur.map((l) => (l._key === key ? { ...l, ...patch } : l)));
  };

  const onPickCode = (key: string, code: string) => {
    const sku = skuByCode.get(code);
    setLine(key, {
      productCode: code,
      productName: sku?.name ?? '',
    });
  };

  const addLine    = () => setLines((cur) => [...cur, blankLine()]);
  const removeLine = (key: string) =>
    setLines((cur) => (cur.length <= 1 ? cur : cur.filter((l) => l._key !== key)));

  // ── Validation ───────────────────────────────────────────────────────
  const sameWarehouse = Boolean(
    fromWarehouseId && toWarehouseId && fromWarehouseId === toWarehouseId,
  );
  const validLines = lines.filter((l) => l.productCode.trim() && l.qty > 0);
  const overdrawn = validLines.filter((l) => {
    const avail = balanceMap.get(l.productCode);
    if (avail == null) return false; // unknown — don't block
    return l.qty > avail;
  });

  const canSave = Boolean(
    fromWarehouseId &&
    toWarehouseId &&
    !sameWarehouse &&
    transferDate &&
    validLines.length > 0,
  );

  const onSave = async () => {
    if (!canSave) {
      notify({ title: 'Pick From + To warehouses (must differ), date, and at least one valid line.', tone: 'error' });
      return;
    }
    if (overdrawn.length > 0) {
      const proceed = await askConfirm({
        title: 'Some lines exceed available stock at the source warehouse',
        body:
          overdrawn.map((l) => `  ${l.productCode}: want ${l.qty}, have ${balanceMap.get(l.productCode) ?? 0}`).join('\n') +
          `\n\nSaving will post immediately and push the source balance negative. Continue?`,
        confirmLabel: 'Post anyway',
        danger: true,
      });
      if (!proceed) return;
    }

    create.mutate(
      {
        fromWarehouseId,
        toWarehouseId,
        transferDate,
        notes: notes.trim() || undefined,
        items: validLines.map(({ _key: _ignored, ...rest }) => ({
          ...rest,
          productName: rest.productName?.trim() || undefined,
          notes:       rest.notes?.trim()       || undefined,
        })),
      },
      {
        onSuccess: (res) => navigate(`/scm/stock-transfers/${res.id}`),
        onError:   (err) => notify({ title: 'Save failed', body: err instanceof Error ? err.message : String(err), tone: 'error' }),
      },
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/scm/stock-transfers" className={styles.backBtn}>
            <ArrowLeft {...ICON} /> <span>Stock Transfers</span>
          </Link>
          <h1 className={styles.title}>New Stock Transfer</h1>
        </div>
        <div className={styles.actions}>
          <Button variant="ghost" size="md" onClick={() => navigate('/scm/stock-transfers')}>
            <X {...ICON} /> Cancel
          </Button>
          <Button variant="primary" size="md" onClick={onSave} disabled={create.isPending}>
            <Save {...ICON} />
            {create.isPending ? 'Posting…' : 'Post Transfer'}
          </Button>
        </div>
      </div>

      {/* ── Header card ──────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Transfer</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>From Warehouse *</span>
              <select
                value={fromWarehouseId}
                onChange={(e) => setFromWarehouseId(e.target.value)}
                className={styles.fieldSelect}
              >
                <option value="">— Pick source —</option>
                {sortByText(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.code} · {w.name}</option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                <ArrowRight size={11} strokeWidth={1.75} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                To Warehouse *
              </span>
              <select
                value={toWarehouseId}
                onChange={(e) => setToWarehouseId(e.target.value)}
                className={styles.fieldSelect}
              >
                <option value="">— Pick destination —</option>
                {sortByText(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id} disabled={w.id === fromWarehouseId}>
                    {w.code} · {w.name}{w.id === fromWarehouseId ? ' (source)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Transfer Date *</span>
              <input
                type="date"
                value={transferDate}
                onChange={(e) => setTransferDate(e.target.value)}
                className={styles.fieldInput}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="(optional)"
                className={styles.fieldInput}
              />
            </label>
          </div>

          {sameWarehouse && (
            <div style={{
              marginTop: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              background: 'rgba(184, 51, 31, 0.08)',
              border: '1px solid var(--c-festive-b, #B8331F)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--fs-13)',
              color: 'var(--c-festive-b, #B8331F)',
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            }}>
              <AlertTriangle size={16} strokeWidth={1.75} />
              <span>Source and destination warehouses must be different.</span>
            </div>
          )}
        </div>
      </section>

      {/* ── Items card ──────────────────────────────────────────────── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Items</h2>
          <Button variant="ghost" size="sm" onClick={addLine}>
            <Plus size={14} strokeWidth={1.75} /> Add Line Item
          </Button>
        </div>
        <div className={styles.cardBody}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: '20%' }}>SKU *</th>
                <th>Description</th>
                <th style={{ width: 110, textAlign: 'right' }}>Available</th>
                <th style={{ width: 110, textAlign: 'right' }}>Qty *</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((ln) => {
                const avail = ln.productCode ? balanceMap.get(ln.productCode) : undefined;
                const isOverdrawn = avail != null && ln.qty > avail;
                return (
                  <tr key={ln._key}>
                    <td>
                      <input
                        type="text"
                        list={`xfer-skus-${ln._key}`}
                        value={ln.productCode}
                        onChange={(e) => onPickCode(ln._key, e.target.value)}
                        placeholder="Type code…"
                        className={styles.fieldInput}
                        style={{ fontFamily: 'var(--font-mono)' }}
                      />
                      <datalist id={`xfer-skus-${ln._key}`}>
                        {sortByText(allSkus.data ?? []).map((p) => (
                          <option key={p.id} value={p.code}>{p.name}</option>
                        ))}
                      </datalist>
                    </td>
                    <td>
                      <input
                        type="text"
                        value={ln.productName ?? ''}
                        onChange={(e) => setLine(ln._key, { productName: e.target.value })}
                        placeholder="(auto-filled when SKU picked)"
                        className={styles.fieldInput}
                        style={{ background: 'var(--c-cream)' }}
                      />
                    </td>
                    <td className={styles.tableRight}
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-13)' }}>
                      {!fromWarehouseId
                        ? <span className={styles.muted}>—</span>
                        : !ln.productCode
                          ? <span className={styles.muted}>—</span>
                          : balances.isLoading
                            ? <span className={styles.muted}>…</span>
                            : (
                              <span style={{
                                color: (avail ?? 0) > 0 ? 'var(--c-ink)' : 'var(--fg-muted)',
                              }}>
                                {(avail ?? 0).toLocaleString('en-MY')}
                              </span>
                            )
                      }
                    </td>
                    <td className={styles.tableRight}>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={ln.qty}
                        onChange={(e) => {
                          const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
                          setLine(ln._key, { qty: n });
                        }}
                        className={styles.fieldInput}
                        style={{
                          textAlign: 'right',
                          fontFamily: 'var(--font-mono)',
                          color: isOverdrawn ? 'var(--c-festive-b, #B8331F)' : 'var(--c-ink)',
                        }}
                      />
                    </td>
                    <td className={styles.actionsCell}>
                      <button
                        type="button"
                        onClick={() => removeLine(ln._key)}
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        disabled={lines.length <= 1}
                        title="Remove line"
                      >
                        <Trash2 size={14} strokeWidth={1.75} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className={styles.addLineRow}>
            <Button variant="ghost" size="sm" onClick={addLine}>
              <Plus size={14} strokeWidth={1.75} /> Add Line Item
            </Button>
          </div>

          {overdrawn.length > 0 && (
            <div style={{
              marginTop: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              background: 'rgba(184, 51, 31, 0.08)',
              border: '1px solid var(--c-festive-b, #B8331F)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--fs-13)',
              color: 'var(--c-festive-b, #B8331F)',
              display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)',
            }}>
              <AlertTriangle size={16} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                <strong>{overdrawn.length} line{overdrawn.length === 1 ? '' : 's'} exceed available stock.</strong>
                {' '}Saving will post immediately and push the source balance negative.
                You'll be asked to confirm on Save.
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
