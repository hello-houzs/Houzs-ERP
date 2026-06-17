// ----------------------------------------------------------------------------
// SalesOrderNew — full-page Create Sales Order at /sales-orders/new.
//
// Faithful Houzs-style port of 2990s apps/backend/src/pages/SalesOrderNew.tsx
// (AutoCount-style full-page form). Captures the customer header (name + phone
// required, address / state / delivery date) and manual line items, then POSTs
// to /api/mfg-sales-orders. The SO is created CONFIRMED.
//
// SEAM changes (same playbook as PurchaseInvoiceNew):
//   - Data layer: 2990s flow-queries (authedFetch) -> the SO hooks in
//     ./sales-orders-queries (Houzs api client + TanStack).
//   - Components: @2990s/design-system Button -> Houzs components/Button; 2990s
//     MoneyInput / PhoneInput / the customer-search autocomplete + sofa/bedframe
//     configurator -> plain inputs + a minimal inline RM<->centi editor;
//     react-router -> react-router-dom.
//
// Strategy-2 product-layer simplifications (Houzs is not the furniture business):
//   - DROPPED the furniture line machinery: the sofa/bedframe/mattress
//     configurator, fabric-tier / combo pricing, PWP, the server-side pricing
//     recompute + drift gate, mfg_products SKU picker. A line is plain text:
//     Item Code + Description + Group + Qty + Unit Price. The server stores the
//     operator's figures verbatim (generic non-furniture path).
//     TODO: wire a product source + variant editors in the Products slice.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Save, Trash2, ChevronDown } from "lucide-react";
import { Button } from "../../components/Button";
import { useCreateSalesOrder, type NewSoItem } from "./sales-orders-queries";
import styles from "./PurchaseOrderDetail.module.css";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;

const todayMyt = (): string => new Date().toISOString().slice(0, 10);

const fmtRm = (centi: number, currency = "MYR"): string =>
  `${currency} ${(centi / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ITEM_GROUPS = ["sofa", "mattress", "bedframe", "accessory", "service", "others"];

type DraftLine = {
  rid: string;
  itemGroup: string;
  itemCode: string;
  description: string;
  qty: number;
  unitPriceCenti: number;
  unitCostCenti: number;
};

const blankLine = (): DraftLine => ({
  rid: `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  itemGroup: "others",
  itemCode: "",
  description: "",
  qty: 1,
  unitPriceCenti: 0,
  unitCostCenti: 0,
});

export const SalesOrderNew = () => {
  const navigate = useNavigate();
  const create = useCreateSalesOrder();
  const saving = create.isPending;

  // Header.
  const [debtorName, setDebtorName] = useState("");
  const [phone, setPhone] = useState("");
  const [debtorCode, setDebtorCode] = useState("");
  const [email, setEmail] = useState("");
  const [customerType, setCustomerType] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [postcode, setPostcode] = useState("");
  const [customerState, setCustomerState] = useState("");
  const [buildingType, setBuildingType] = useState("");
  const [poDocNo, setPoDocNo] = useState("");
  const [ref, setRef] = useState("");
  const [agent, setAgent] = useState("");
  const [branding, setBranding] = useState("");
  const [customerDeliveryDate, setCustomerDeliveryDate] = useState("");
  const [internalExpectedDd, setInternalExpectedDd] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);

  const setLine = (rid: string, patch: Partial<DraftLine>) => setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  const dropLine = (rid: string) => setLines((prev) => prev.filter((l) => l.rid !== rid));
  const addLine = () => setLines((prev) => [...prev, blankLine()]);

  const subtotalCenti = useMemo(() => lines.reduce((s, l) => s + l.qty * l.unitPriceCenti, 0), [lines]);

  const canSave = debtorName.trim().length > 0 && phone.trim().length > 0;

  const onSave = async () => {
    if (!canSave) {
      window.alert("Customer name and phone are required.");
      return;
    }
    // Processing + delivery date must pair (server enforces; pre-check for UX).
    if (Boolean(internalExpectedDd) !== Boolean(customerDeliveryDate)) {
      window.alert("Processing Date and Delivery Date must be set together (or both left empty).");
      return;
    }
    const realLines = lines.filter((l) => l.itemCode.trim());
    if (realLines.some((l) => l.qty < 1)) {
      window.alert("Each line needs a quantity of at least 1.");
      return;
    }
    try {
      const items: NewSoItem[] = realLines.map((l) => ({
        itemGroup: l.itemGroup,
        itemCode: l.itemCode.trim(),
        description: l.description || null,
        qty: l.qty,
        unitPriceCenti: l.unitPriceCenti,
        unitCostCenti: l.unitCostCenti || undefined,
      }));
      const res = await create.mutateAsync({
        debtorName: debtorName.trim(),
        phone: phone.trim(),
        debtorCode: debtorCode || null,
        email: email || null,
        customerType: customerType || null,
        address1: address1 || null,
        address2: address2 || null,
        city: city || null,
        postcode: postcode || null,
        customerState: customerState || null,
        buildingType: buildingType || null,
        poDocNo: poDocNo || null,
        ref: ref || null,
        agent: agent || null,
        branding: branding || null,
        customerDeliveryDate: customerDeliveryDate || null,
        internalExpectedDd: internalExpectedDd || null,
        note: note || null,
        items,
      });
      navigate(`/sales-orders/${res.docNo ?? res.doc_no}`);
    } catch (err) {
      window.alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Link to="/sales-orders" className={styles.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </Link>
          <div>
            <h1 className={styles.title}>New Sales Order</h1>
          </div>
        </div>
        <div className={styles.actions}>
          <div className={styles.totalRail}>
            <span className={styles.totalRailLabel}>Total</span>
            <span className={styles.totalRailValue}>{fmtRm(subtotalCenti)}</span>
          </div>
          <Button variant="primary" onClick={onSave} disabled={saving || !canSave}>
            <Save {...ICON} />
            <span>{saving ? "Saving…" : "Create Sales Order"}</span>
          </Button>
        </div>
      </div>

      {/* Customer header. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Customer</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: "span 2" }}>
              <span className={styles.fieldLabel}>Customer Name *</span>
              <input className={styles.fieldInput} value={debtorName} onChange={(e) => setDebtorName(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Phone *</span>
              <input className={styles.fieldInput} value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Code</span>
              <input className={styles.fieldInput} value={debtorCode} onChange={(e) => setDebtorCode(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: "span 2" }}>
              <span className={styles.fieldLabel}>Email</span>
              <input className={styles.fieldInput} value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer Type</span>
              <input className={styles.fieldInput} value={customerType} placeholder="NEW / EXISTING" onChange={(e) => setCustomerType(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Building Type</span>
              <input className={styles.fieldInput} value={buildingType} placeholder="Condo / Landed / …" onChange={(e) => setBuildingType(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: "span 2" }}>
              <span className={styles.fieldLabel}>Address Line 1</span>
              <input className={styles.fieldInput} value={address1} onChange={(e) => setAddress1(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: "span 2" }}>
              <span className={styles.fieldLabel}>Address Line 2</span>
              <input className={styles.fieldInput} value={address2} onChange={(e) => setAddress2(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>City</span>
              <input className={styles.fieldInput} value={city} onChange={(e) => setCity(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Postcode</span>
              <input className={styles.fieldInput} value={postcode} onChange={(e) => setPostcode(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>State</span>
              <input className={styles.fieldInput} value={customerState} onChange={(e) => setCustomerState(e.target.value)} />
            </label>
          </div>
        </div>
      </section>

      {/* Order header. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Order Details</h2>
        </header>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer PO #</span>
              <input className={styles.fieldInput} value={poDocNo} onChange={(e) => setPoDocNo(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Reference</span>
              <input className={styles.fieldInput} value={ref} onChange={(e) => setRef(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Agent</span>
              <input className={styles.fieldInput} value={agent} onChange={(e) => setAgent(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Branding</span>
              <input className={styles.fieldInput} value={branding} onChange={(e) => setBranding(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Delivery Date</span>
              <input type="date" className={styles.fieldInput} value={customerDeliveryDate} onChange={(e) => setCustomerDeliveryDate(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Processing Date</span>
              <input type="date" className={styles.fieldInput} value={internalExpectedDd} onChange={(e) => setInternalExpectedDd(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: "span 2" }}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.fieldInput} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
        </div>
      </section>

      {/* Line items. */}
      <section className={styles.card}>
        <header className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Line Items ({lines.length})</h2>
        </header>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Group</th>
              <th>Item Code</th>
              <th>Description</th>
              <th className={styles.tableRight}>Qty</th>
              <th className={styles.tableRight}>Unit Price</th>
              <th className={styles.tableRight}>Line Total</th>
              <th className={styles.tableRight}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.rid}>
                <td>
                  <span className={styles.selectWrap}>
                    <select className={styles.fieldSelect} style={{ width: 120 }} value={l.itemGroup} onChange={(e) => setLine(l.rid, { itemGroup: e.target.value })}>
                      {ITEM_GROUPS.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
                  </span>
                </td>
                <td>
                  <input className={styles.fieldInput} style={{ width: 130 }} value={l.itemCode} placeholder="Code" onChange={(e) => setLine(l.rid, { itemCode: e.target.value })} />
                </td>
                <td>
                  <input className={styles.fieldInput} style={{ width: 220 }} value={l.description} placeholder="Description" onChange={(e) => setLine(l.rid, { description: e.target.value })} />
                </td>
                <td className={styles.tableRight}>
                  <input type="number" min={1} className={styles.fieldInput} style={{ width: 70, textAlign: "right" }} value={l.qty} onChange={(e) => setLine(l.rid, { qty: Math.max(1, Number(e.target.value) || 1) })} />
                </td>
                <td className={styles.tableRight}>
                  <InlineRmInput valueCenti={l.unitPriceCenti} onCommit={(centi) => setLine(l.rid, { unitPriceCenti: centi })} style={{ width: 110 }} />
                </td>
                <td className={styles.priceCell}>{fmtRm(l.qty * l.unitPriceCenti)}</td>
                <td className={styles.tableRight}>
                  <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} title="Remove line" onClick={() => dropLine(l.rid)}>
                    <Trash2 {...SM_ICON} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className={styles.cardBody}>
          <Button variant="ghost" onClick={addLine}>
            <Plus {...ICON} />
            <span>Add another item</span>
          </Button>
        </div>
      </section>
    </div>
  );
};

/* Minimal inline RM<->centi editor (no MoneyInput in this slice). */
const InlineRmInput = ({ valueCenti, onCommit, style }: { valueCenti: number; onCommit: (centi: number) => void; style?: React.CSSProperties }) => {
  const toRm = (c: number) => (c ? (c / 100).toFixed(2) : "");
  const [draft, setDraft] = useState(toRm(valueCenti));
  const [committed, setCommitted] = useState(valueCenti);
  if (committed !== valueCenti) {
    setCommitted(valueCenti);
    setDraft(toRm(valueCenti));
  }
  const commit = () => {
    const t = draft.trim();
    const n = t === "" ? 0 : Number(t);
    const next = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : valueCenti;
    onCommit(next);
  };
  return (
    <input
      className={styles.fieldInput}
      style={{ textAlign: "right", ...style }}
      value={draft}
      inputMode="decimal"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(toRm(valueCenti));
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
};
