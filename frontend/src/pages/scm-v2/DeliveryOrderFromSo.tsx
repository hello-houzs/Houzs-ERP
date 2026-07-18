// ----------------------------------------------------------------------------
// DeliveryOrderFromSo — LINE-LEVEL, QUANTITY-BASED Sales Order → Delivery Order
// picker.
//
// Commander 2026-05-30 rewrite: partial-delivery model, mirroring the PO's
// line-level from-SO picker (pages/PurchaseOrderFromSo.tsx). Instead of ticking
// whole Sales Orders, the operator picks individual SO LINES, each with a qty
// 1..remaining. An SO line can be split across SEVERAL Delivery Orders until its
// remaining (qty − delivered + returned, derived LIVE by the server) reaches 0:
//   - Partially delivered (remaining > 0) → the line is still pickable.
//   - Fully delivered (remaining == 0) → the line drops out of the picker.
//   - Cancelling a DO, deleting a DO line, or processing a Delivery Return
//     RAISES remaining again automatically (the server re-derives it).
//
// A customer-lock keeps the merge clean: once one line is ticked, lines of a
// DIFFERENT customer grey out — a DO ships to ONE customer.
//
// On "Continue" the picked lines are carried into the normal New Delivery Order
// form (prefilled, reviewable) — NOTHING is created or shipped yet. The operator
// reviews/edits and clicks "Create DO" there to actually ship + deduct stock.
// This mirrors the PO picker (PurchaseOrderFromSo), which also stashes its picks
// and hands them to the New PO form rather than auto-creating.
//
// Routing: /scm/delivery-orders/from-so → /scm/delivery-orders/new.
// ----------------------------------------------------------------------------

import { useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, X, CheckSquare, Square } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import { useDeliverableSoLines, type DeliverableSoLine } from '../../vendor/scm/lib/delivery-order-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { ActionResultDialog } from '../../vendor/scm/components/ActionResultDialog';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (centi: number, currency = 'MYR'): string =>
  `${currency} ${(centi / 100).toLocaleString('en-MY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

const STORAGE_KEY = 'pr-g.do-from-so-lines.layout.v1';

/* Compact pill input — mirrors the PO picker's qty input. */
const QTY_INPUT: CSSProperties = {
  height: 28,
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 8px',
  fontSize: 'var(--fs-12)',
  background: 'var(--c-paper)',
  color: 'var(--c-ink)',
};

/* One distinct customer key per SO line — match the server's same-customer
   rule: debtor_code when present, else fall back to debtor_name. The lock greys
   out any line whose key differs from the first ticked one. */
const custKey = (l: DeliverableSoLine): string =>
  (l.debtorCode && l.debtorCode.trim())
    ? `code:${l.debtorCode.trim().toUpperCase()}`
    : `name:${(l.debtorName ?? '').trim().toUpperCase()}`;

type Pick = { picked: boolean; qty: number };

export const DeliveryOrderFromSo = () => {
  const navigate = useNavigate();
  const linesQ = useDeliverableSoLines();

  // Map<soItemId, { picked, qty }>. Defaults: picked = false; when ticked,
  // qty defaults to the line's remaining.
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [dialog, setDialog] = useState<{ title: string; body: string } | null>(null);

  const rows = useMemo<DeliverableSoLine[]>(() => linesQ.data ?? [], [linesQ.data]);

  const rowById = useMemo(() => {
    const m = new Map<string, DeliverableSoLine>();
    for (const r of rows) m.set(r.soItemId, r);
    return m;
  }, [rows]);

  /* The customer locked in by the current picks — the key of the first picked
     line. Null when nothing is picked (every line is selectable). */
  const lockedCustomer = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const r = rowById.get(id);
      if (r) return custKey(r);
    }
    return null;
  }, [picks, rowById]);

  const lockedCustomerName = useMemo(() => {
    for (const [id, v] of Object.entries(picks)) {
      if (!v.picked) continue;
      const r = rowById.get(id);
      if (r) return r.debtorName ?? r.debtorCode ?? '(none)';
    }
    return null;
  }, [picks, rowById]);

  // A row is LOCKED when a different customer is already picked.
  const isRowLocked = (r: DeliverableSoLine): boolean =>
    Boolean(lockedCustomer && custKey(r) !== lockedCustomer && !picks[r.soItemId]?.picked);

  const togglePick = (r: DeliverableSoLine) => {
    if (isRowLocked(r)) return; // can't tick a different customer
    const turningOn = !picks[r.soItemId]?.picked;
    setPicks((s) => ({
      ...s,
      [r.soItemId]: turningOn
        ? { picked: true, qty: s[r.soItemId]?.qty || r.remaining }
        : { picked: false, qty: 0 },
    }));
  };

  const setQty = (r: DeliverableSoLine, qty: number) => {
    if (isRowLocked(r)) return;
    setPicks((s) => ({ ...s, [r.soItemId]: { picked: true, qty } }));
  };

  // Select / clear all currently-VISIBLE rows. Select-all respects the lock:
  // it only adds lines of the locked customer (or, if nothing is picked yet, all
  // lines of the FIRST row's customer so the result is a valid single-customer
  // set).
  const selectAll = () => {
    setPicks((s) => {
      const next = { ...s };
      const key = lockedCustomer ?? (rows[0] ? custKey(rows[0]) : null);
      if (!key) return next;
      for (const r of rows) if (custKey(r) === key) next[r.soItemId] = { picked: true, qty: r.remaining };
      return next;
    });
  };
  const clearAll = () => setPicks({});

  const picked = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const pickedCount = picked.length;

  const columns = useMemo<DataGridColumn<DeliverableSoLine>[]>(() => [
    {
      key: 'pick', label: '', width: 40, sortable: false, groupable: false,
      accessor: (r) => {
        const on = Boolean(picks[r.soItemId]?.picked);
        const locked = isRowLocked(r);
        return (
          <input
            type="checkbox"
            checked={on}
            disabled={locked}
            onChange={() => togglePick(r)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Pick ${r.itemCode}`}
            style={locked ? { cursor: 'not-allowed' } : undefined}
          />
        );
      },
    },
    {
      key: 'docNo', label: 'SO No', width: 140, sortable: true, groupable: true,
      accessor: (r) => <span className={styles.codeCell}>{r.docNo}</span>,
      searchValue: (r) => r.docNo,
      groupValue: (r) => r.docNo,
    },
    {
      key: 'debtorName', label: 'Customer', width: 200, sortable: true, groupable: true,
      accessor: (r) => r.debtorName ?? '—',
      searchValue: (r) => r.debtorName ?? '',
      groupValue: (r) => r.debtorName ?? '(none)',
    },
    {
      key: 'itemGroup', label: 'Category', width: 110, sortable: true, groupable: true,
      accessor: (r) => <ItemGroupPill group={r.itemGroup} />,
      searchValue: (r) => r.itemGroup ?? '',
      groupValue: (r) => (r.itemGroup ?? '(none)').toUpperCase(),
    },
    {
      key: 'itemCode', label: 'Item Code', width: 130, sortable: true,
      accessor: (r) => <span style={{ fontWeight: 600 }}>{r.itemCode}</span>,
      searchValue: (r) => r.itemCode ?? '',
    },
    {
      key: 'description', label: 'Description', width: 260, sortable: true,
      accessor: (r) => (
        <VariantDescription
          itemCode={r.itemCode}
          itemGroup={r.itemGroup}
          variants={r.variants}
          description={r.description}
          mutedClassName={styles.muted}
        />
      ),
      searchValue: (r) => `${r.description ?? ''} ${r.description2 ?? ''}`.trim(),
    },
    {
      key: 'qty', label: 'SO Qty', width: 70, align: 'right', sortable: true,
      accessor: (r) => String(r.qty),
      sortFn: (a, b) => a.qty - b.qty,
    },
    {
      key: 'delivered', label: 'Delivered', width: 80, align: 'right', sortable: true,
      accessor: (r) => <span className={styles.muted}>{r.delivered}</span>,
      sortFn: (a, b) => a.delivered - b.delivered,
    },
    {
      key: 'remaining', label: 'Remaining', width: 80, align: 'right', sortable: true,
      accessor: (r) => <span style={{ fontWeight: 700, color: 'var(--c-burnt)' }}>{r.remaining}</span>,
      sortFn: (a, b) => a.remaining - b.remaining,
    },
    {
      key: 'pickQty', label: 'Qty to Deliver', width: 110, align: 'right', sortable: false, groupable: false,
      accessor: (r) => {
        const p = picks[r.soItemId];
        const on = Boolean(p?.picked);
        const locked = isRowLocked(r);
        return (
          <input
            type="number"
            min={0}
            max={r.remaining}
            value={on ? p!.qty : ''}
            placeholder={String(r.remaining)}
            disabled={locked}
            /* Always editable: typing a qty auto-selects the row (no need to
               tick the checkbox first). */
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              setQty(r, Math.min(r.remaining, Math.max(0, Number(e.target.value) || 0)))}
            style={{ ...QTY_INPUT, width: 76, textAlign: 'right', ...(locked ? { cursor: 'not-allowed', background: 'var(--c-cream)' } : null) }}
          />
        );
      },
    },
    {
      key: 'lineValue', label: 'Line Value', width: 130, align: 'right', sortable: true,
      accessor: (r) => {
        const p = picks[r.soItemId];
        const pickQty = p?.picked ? p.qty : r.remaining;
        return (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
            {fmtRm(pickQty * r.unitPriceCenti)}
          </span>
        );
      },
      sortFn: (a, b) => a.remaining * a.unitPriceCenti - b.remaining * b.unitPriceCenti,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- column accessors derive from the pick/qty state already in deps; listing the helpers would only rebuild the columns for no behavioural change
  ], [picks, lockedCustomer]);

  const onContinue = () => {
    if (pickedCount === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Sales Order line to deliver first.' });
      return;
    }
    /* Carry the picked lines into the normal New Delivery Order form (prefilled,
       reviewable) — NOTHING is created or shipped here. The operator reviews the
       draft and clicks Create on the next screen. Mirrors the PO picker, which
       also stashes picks and navigates to the New PO form. */
    const stash = picked
      .map(([soItemId, v]) => {
        const r = rowById.get(soItemId);
        if (!r) return null;
        return {
          soItemId,
          docNo: r.docNo,
          itemCode: r.itemCode,
          itemGroup: r.itemGroup ?? 'others',
          description: r.description ?? '',
          uom: r.uom ?? 'UNIT',
          qty: v.qty,
          unitPriceCenti: r.unitPriceCenti,
          discountCenti: r.discountCenti,
          unitCostCenti: r.unitCostCenti,
          variants: r.variants ?? {},
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (stash.length === 0) {
      setDialog({ title: 'Nothing picked', body: 'Tick at least one Sales Order line to deliver first.' });
      return;
    }
    /* Header/address prefill mirrors the same-customer rule: use the SO of the
       sorted-first picked line. Each line keeps its own soItemId, so multiple
       same-customer SOs still link back correctly. */
    const firstDocNo = stash.map((s) => s.docNo).sort()[0] ?? '';
    sessionStorage.setItem('doFromSoPicks', JSON.stringify(stash));
    navigate(`/scm/delivery-orders/new?fromSo=${encodeURIComponent(firstDocNo)}&fromPicks=1`);
  };

  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
      <Button variant="ghost" size="sm" onClick={selectAll} disabled={rows.length === 0}>
        <CheckSquare {...ICON} /> Select all
      </Button>
      <Button variant="ghost" size="sm" onClick={clearAll} disabled={pickedCount === 0}>
        <Square {...ICON} /> Clear all
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Supply Chain"
        title="Pick Sales Order lines to deliver"
        actions={
          <>
            <Link to="/scm/delivery-orders" className={styles.backBtn}>
              <ArrowLeft {...ICON} /> <span>Delivery Orders</span>
            </Link>
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/delivery-orders')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button
                variant="primary" size="md"
                onClick={() => onContinue()}
                disabled={pickedCount === 0}
                title="Carry the picked Sales Order lines into a new Delivery Order to review"
              >
                <ArrowRight {...ICON} />
                {pickedCount === 0
                  ? 'Pick at least 1 line'
                  : `Continue with ${pickedCount} line${pickedCount === 1 ? '' : 's'}`}
              </Button>
            </div>
          </>
        }
      />
      <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        Pick the Sales Order lines you want to deliver and set the quantity for each. A line can be
        delivered in parts across several Delivery Orders — only the remaining (not-yet-delivered)
        quantity is shown. Continue carries the picked lines into a new Delivery Order form for you to
        review — nothing ships and no stock is deducted until you click Create on that screen.
      </p>
      {lockedCustomerName && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          One customer per Delivery Order — locked to <strong>{lockedCustomerName}</strong>. Other
          customers' lines are greyed out; clear picks to switch.
        </p>
      )}

      <DataGrid<DeliverableSoLine>
        rows={rows}
        columns={columns}
        storageKey={STORAGE_KEY}
        rowKey={(r) => r.soItemId}
        searchPlaceholder="Search SO, customer, item…"
        onRowClick={(r) => togglePick(r)}
        rowStyle={(r) => isRowLocked(r)
          ? { opacity: 0.45, background: 'var(--c-cream)', cursor: 'not-allowed' }
          : undefined}
        toolbar={toolbar}
        groupBanner={false}
        isLoading={linesQ.isLoading}
        emptyMessage="No deliverable Sales Order lines — every line has been fully delivered (or there are no Sales Orders)."
      />

      {dialog && (
        <ActionResultDialog
          title={dialog.title}
          body={dialog.body}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};
