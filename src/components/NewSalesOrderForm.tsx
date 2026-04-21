// New Sales Order modal — EXACT layout clone of Inistate /sales/order form.
// Labels right-aligned with icon suffix; values on the right.
// Two-column grid: left column = most fields, right column = Salesperson + Debtor Code.

import { useState, useMemo, type ReactNode } from "react";
import {
  X, Plus, Trash2, Check, ShoppingCart, Package,
  Calendar as CalIcon, User as UserIcon, Phone, Mail, MapPin,
  Tag, Hash, Home, Briefcase, FileText, DollarSign,
} from "lucide-react";
import { BRANDS } from "@/lib/mock-data";
import {
  addSOHeader, addSOLine, nextSODocNo,
  ITEM_GROUPS, PAYMENT_STATUSES,
  type ItemGroup, type PaymentStatus, type SOHeader,
} from "@/lib/so-store";
import { useSKUCostings } from "@/lib/sku-costing-store";

interface LineRow {
  uid: string;
  itemCode: string;
  description: string;
  itemGroup: ItemGroup;
  uom: string;
  qty: number;
  unitPrice: number;
  remarks: string;
}

interface PaymentRow {
  uid: string;
  date: string;
  method: string;        // MBB, CASH, VISA, EPP, ONLINE, etc.
  amount: number;
  accountSheet: string;  // e.g. AKHC 3809
  approvalCode: string;
  collectedBy: string;
}

const PAYMENT_METHODS = ["CASH", "MBB", "VISA", "MASTER", "CREDIT CARD", "EPP", "ONLINE", "TNG", "DUITNOW", "OTHER"] as const;

interface Props {
  onClose: () => void;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function blankLine(): LineRow {
  return { uid: uid(), itemCode: "", description: "", itemGroup: "MATTRESS", uom: "UNIT", qty: 1, unitPrice: 0, remarks: "" };
}

function blankPayment(): PaymentRow {
  return { uid: uid(), date: new Date().toISOString().slice(0, 10), method: "CASH", amount: 0, accountSheet: "", approvalCode: "", collectedBy: "" };
}

// ─── Inistate-style row: label (right-aligned) + icon + value ────────────────
function Row({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-center gap-x-3 py-1.5">
      <div className="text-[12px] text-[#9CA3AF] text-right inline-flex items-center justify-end gap-1 whitespace-nowrap">
        <span>{label}</span>
        {icon}
      </div>
      <div className="text-[13px] text-[#0A1F2E]">{children}</div>
    </div>
  );
}

// Inline text input — borderless like Inistate, only underline on focus
function Inp(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full h-7 px-0 bg-transparent text-[13px] text-[#0A1F2E] border-0 border-b border-transparent
                  focus:outline-none focus:border-[#0F766E] placeholder:text-[#D1D5DB] ${props.className ?? ""}`}
    />
  );
}

function Sel(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full h-7 px-0 bg-transparent text-[13px] text-[#0A1F2E] border-0 border-b border-transparent
                  focus:outline-none focus:border-[#0F766E] cursor-pointer ${props.className ?? ""}`}
    />
  );
}

export default function NewSalesOrderForm({ onClose }: Props) {
  const skus = useSKUCostings();

  // Header state
  const [docNo] = useState(() => nextSODocNo());
  const today = new Date().toISOString().slice(0, 10);
  const [orderDate, setOrderDate] = useState(today);
  const [processingDate, setProcessingDate] = useState(today);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [debtorName, setDebtorName] = useState("");
  const [debtorCode, setDebtorCode] = useState("");
  const [agent, setAgent] = useState("");
  const [branding, setBranding] = useState<string>(BRANDS[0]);
  const [status, setStatus] = useState("");
  const [status2, setStatus2] = useState("MATTRESS/ACC");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [postcode, setPostcode] = useState("");
  const [stateName, setStateName] = useState("Selangor");
  const [contact1, setContact1] = useState("");
  const [contact2, setContact2] = useState("");
  const [email, setEmail] = useState("");
  const [venue, setVenue] = useState("");
  const [warehouse, setWarehouse] = useState("KL");
  const [reference, setReference] = useState("");
  const [source, setSource] = useState("");
  const [poDocNo, setPoDocNo] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("Unchecked");
  const [orderRemarks, setOrderRemarks] = useState("");
  const [note, setNote] = useState("");

  const [lines, setLines] = useState<LineRow[]>([blankLine()]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);

  const subtotal = useMemo(() =>
    lines.reduce((s, l) => s + l.qty * l.unitPrice, 0), [lines]);

  const depositPaid = useMemo(() =>
    payments.reduce((s, p) => s + (p.amount || 0), 0), [payments]);

  const balanceOutstanding = subtotal - depositPaid;

  function updateLine(uidKey: string, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l) => l.uid === uidKey ? { ...l, ...patch } : l));
  }
  function pickSKU(uidKey: string, itemCode: string) {
    const sku = skus.find((s) => s.itemCode === itemCode);
    if (!sku) { updateLine(uidKey, { itemCode }); return; }
    const ig: ItemGroup = (ITEM_GROUPS as readonly string[]).includes(sku.itemGroup)
      ? (sku.itemGroup as ItemGroup) : "OTHERS";
    updateLine(uidKey, {
      itemCode: sku.itemCode, description: sku.description,
      itemGroup: ig, uom: sku.uom || "UNIT",
    });
  }
  function addLine() { setLines((prev) => [...prev, blankLine()]); }
  function removeLine(uidKey: string) {
    setLines((prev) => prev.length > 1 ? prev.filter((l) => l.uid !== uidKey) : prev);
  }

  function updatePayment(uidKey: string, patch: Partial<PaymentRow>) {
    setPayments((prev) => prev.map((p) => p.uid === uidKey ? { ...p, ...patch } : p));
  }
  function addPayment() { setPayments((prev) => [...prev, blankPayment()]); }
  function removePayment(uidKey: string) {
    setPayments((prev) => prev.filter((p) => p.uid !== uidKey));
  }

  function submit() {
    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    if (!debtorName.trim() || validLines.length === 0) {
      alert("Please fill in customer name and at least one line item.");
      return;
    }
    // Auto-derive payment status from actual payments
    const derivedStatus: PaymentStatus = balanceOutstanding <= 0 && depositPaid > 0 ? "Checked"
                                         : depositPaid > 0 ? "Pending" : paymentStatus;
    const header: SOHeader = {
      docNo, transferTo: "", date: orderDate, branding,
      debtorName: debtorName.trim(), agent: agent.trim(),
      salesLocation: warehouse, ref: reference,
      localTotal: subtotal,
      mattressSofa: 0, bedframe: 0, accessories: 0, others: 0,
      balance: Math.max(0, balanceOutstanding),
      remark2: status2, remark4: orderRemarks, remark3: status,
      processingDate, salesExemptionExpiry: "", note,
      poDocNo,
      address1, address2, address3: postcode, address4: stateName,
      phone: contact1, venue,
      totalCost: 0, totalRevenue: subtotal, totalMargin: 0, marginPct: 0,
      lineCount: validLines.length,
    };
    addSOHeader(header);
    for (const l of validLines) {
      addSOLine({
        docNo, date: orderDate, debtorCode: debtorCode.trim(),
        debtorName: debtorName.trim(), agent: agent.trim(),
        itemGroup: l.itemGroup, itemCode: l.itemCode.trim().toUpperCase(),
        description: l.description, description2: "",
        uom: (l.uom === "UNIT" || l.uom === "SET" || l.uom === "PAIR" || l.uom === "PCS") ? l.uom : "UNIT",
        location: warehouse, qty: l.qty, unitPrice: l.unitPrice, discount: 0,
        total: l.qty * l.unitPrice, tax: 0, totalInc: l.qty * l.unitPrice,
        balance: Math.max(0, balanceOutstanding), paymentStatus: derivedStatus, venue, branding,
        remark: l.remarks, cancelled: false,
      });
    }
    // Store payments (future enhancement: persist to a payments store)
    try {
      const key = `houzs-so-payments-${docNo}`;
      localStorage.setItem(key, JSON.stringify(payments.filter((p) => p.amount > 0)));
    } catch { /* ignore */ }
    onClose();
  }

  // Status chip colour
  const statusChip = paymentStatus === "Checked" ? "bg-emerald-100 text-emerald-700"
                   : paymentStatus === "Pending" ? "bg-amber-100 text-amber-700"
                   : "bg-gray-200 text-gray-600";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-[960px] max-h-[92vh] flex flex-col">

        {/* Header — customer name + Sales Order label + status chip + close */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-[#E5E7EB]">
          <div>
            <div className="flex items-center gap-2 text-[15px] font-bold text-[#0A1F2E]">
              <span>{debtorName || "New Customer"}</span>
              <span className="inline-flex items-center gap-1 text-[12px] text-gray-500 font-normal">
                <ShoppingCart className="h-3.5 w-3.5" /> Sales Order
              </span>
              <span className={`ml-2 px-2 py-0.5 rounded text-[10px] font-bold uppercase ${statusChip}`}>
                {paymentStatus}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-gray-400 mt-1">
              <span className="font-mono">{docNo}</span>
              <span className="inline-flex items-center gap-1"><UserIcon className="h-3 w-3" /> External</span>
              <span>just now</span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>

        {/* Body — 2-column Inistate-style rows */}
        <div className="px-6 py-3 overflow-y-auto flex-1">
          <div className="grid grid-cols-2 gap-x-12">

            {/* Left column */}
            <div>
              <Row label="Order Date" icon={<CalIcon className="h-3 w-3" />}>
                <Inp type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
              </Row>
              <Row label="Processing Date" icon={<CalIcon className="h-3 w-3" />}>
                <Inp type="date" value={processingDate} onChange={(e) => setProcessingDate(e.target.value)} />
              </Row>
              <Row label="Delivery Date" icon={<CalIcon className="h-3 w-3" />}>
                <Inp type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
              </Row>
              <Row label="Status" icon={<Tag className="h-3 w-3" />}>
                <Inp value={status} onChange={(e) => setStatus(e.target.value)} placeholder="—" />
              </Row>
              <Row label="Status 2" icon={<Tag className="h-3 w-3" />}>
                <Inp value={status2} onChange={(e) => setStatus2(e.target.value)} placeholder="MATTRESS/ACC" />
              </Row>
              <Row label="Name" icon={<UserIcon className="h-3 w-3" />}>
                <Inp value={debtorName} onChange={(e) => setDebtorName(e.target.value)} placeholder="Customer name" />
              </Row>
              <Row label="Address" icon={<MapPin className="h-3 w-3" />}>
                <Inp value={address1} onChange={(e) => setAddress1(e.target.value)} placeholder="Street address" />
              </Row>
              <Row label="Address 2" icon={<MapPin className="h-3 w-3" />}>
                <Inp value={address2} onChange={(e) => setAddress2(e.target.value)} />
              </Row>
              <Row label="Postcode" icon={<Hash className="h-3 w-3" />}>
                <Inp value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="47180" />
              </Row>
              <Row label="State" icon={<MapPin className="h-3 w-3" />}>
                <Inp value={stateName} onChange={(e) => setStateName(e.target.value)} />
              </Row>
              <Row label="Contact No" icon={<Phone className="h-3 w-3" />}>
                <Inp value={contact1} onChange={(e) => setContact1(e.target.value)} placeholder="+60..." />
              </Row>
              <Row label="Contact No 2" icon={<Phone className="h-3 w-3" />}>
                <Inp value={contact2} onChange={(e) => setContact2(e.target.value)} />
              </Row>
              <Row label="Email" icon={<Mail className="h-3 w-3" />}>
                <Inp type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Row>
              <Row label="Venue" icon={<Home className="h-3 w-3" />}>
                <Inp value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Fair / Mall name" />
              </Row>
              <Row label="Warehouse" icon={<Briefcase className="h-3 w-3" />}>
                <Sel value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
                  <option value="KL">KL</option><option value="PG">PG</option><option value="SRW">SRW</option>
                  <option value="JHR">JHR</option><option value="PEN">PEN</option><option value="PER">PER</option>
                </Sel>
              </Row>
              <Row label="Reference" icon={<FileText className="h-3 w-3" />}>
                <Inp value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. HC14087" />
              </Row>
              <Row label="Source" icon={<Tag className="h-3 w-3" />}>
                <Inp value={source} onChange={(e) => setSource(e.target.value)} />
              </Row>
            </div>

            {/* Right column — only Salesperson, Branding, Debtor Code, PO Doc No, Balance */}
            <div>
              <Row label="Salesperson" icon={<UserIcon className="h-3 w-3" />}>
                <Inp value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="e.g. KINGSLEY" />
              </Row>
              <Row label="Branding" icon={<Tag className="h-3 w-3" />}>
                <Sel value={branding} onChange={(e) => setBranding(e.target.value)}>
                  {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                  <option value="NONE">NONE</option>
                </Sel>
              </Row>
              <Row label="Debtor Code" icon={<Hash className="h-3 w-3" />}>
                <Inp value={debtorCode} onChange={(e) => setDebtorCode(e.target.value)} placeholder="300-C001" />
              </Row>
              <Row label="PO Doc No." icon={<FileText className="h-3 w-3" />}>
                <Inp value={poDocNo} onChange={(e) => setPoDocNo(e.target.value)} />
              </Row>
              <Row label="Payment Status" icon={<DollarSign className="h-3 w-3" />}>
                <Sel value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as PaymentStatus)}>
                  {PAYMENT_STATUSES.map((p) => <option key={p} value={p}>{p}</option>)}
                </Sel>
              </Row>
              <Row label="Note" icon={<FileText className="h-3 w-3" />}>
                <Inp value={note} onChange={(e) => setNote(e.target.value)} />
              </Row>
            </div>
          </div>

          {/* Items grid — styled like Inistate's items table */}
          <div className="mt-4">
            <div className="flex items-center gap-2 mb-1">
              <Package className="h-3.5 w-3.5 text-gray-500" />
              <span className="text-[12px] text-gray-500">Items</span>
              <button onClick={addLine}
                      className="ml-auto h-6 px-2 rounded border border-[#E5E7EB] bg-white text-[11px] text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center gap-1">
                <Plus className="h-3 w-3" /> Add Line
              </button>
            </div>
            <div className="border-t border-[#E5E7EB]">
              <div className="grid grid-cols-[40px_2fr_2fr_70px_90px_100px_90px_30px] text-[11px] text-[#9CA3AF] bg-transparent">
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">No <Hash className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Item <Package className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Remarks <FileText className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] text-right inline-flex items-center justify-end gap-1">Quantity <Hash className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] text-right inline-flex items-center justify-end gap-1">Unit Price <DollarSign className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] text-right inline-flex items-center justify-end gap-1">Amount <DollarSign className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB]">Group</div>
                <div className="py-2 border-b border-[#E5E7EB]" />
              </div>
              {lines.map((l, idx) => (
                <div key={l.uid} className="grid grid-cols-[40px_2fr_2fr_70px_90px_100px_90px_30px] text-[12px] border-b border-[#F3F4F6] items-center hover:bg-[#FAFBFB]">
                  <div className="py-2 text-center text-[12px] tabular-nums text-gray-500">{idx + 1}</div>
                  <div className="py-1 pr-2">
                    <input className="w-full h-6 px-0 text-[12px] text-[#0F766E] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]"
                           list="newso-skus" value={l.itemCode}
                           onChange={(e) => pickSKU(l.uid, e.target.value)}
                           placeholder="Select item…" />
                    {l.description && <div className="text-[10px] text-gray-400 truncate">{l.description}</div>}
                  </div>
                  <div className="py-1 pr-2">
                    <input className="w-full h-6 px-0 text-[12px] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]"
                           value={l.remarks}
                           onChange={(e) => updateLine(l.uid, { remarks: e.target.value })}
                           placeholder="—" />
                  </div>
                  <div className="py-1 pr-2 text-right">
                    <input type="number" min={1} className="w-full h-6 px-0 text-[12px] text-right tabular-nums bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]"
                           value={l.qty}
                           onChange={(e) => updateLine(l.uid, { qty: Math.max(1, parseInt(e.target.value) || 1) })} />
                  </div>
                  <div className="py-1 pr-2 text-right">
                    <input type="number" min={0} step="0.01" className="w-full h-6 px-0 text-[12px] text-right tabular-nums bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]"
                           value={l.unitPrice}
                           onChange={(e) => updateLine(l.uid, { unitPrice: parseFloat(e.target.value) || 0 })} />
                  </div>
                  <div className="py-2 pr-2 text-right text-[12px] tabular-nums font-semibold text-[#0A1F2E]">
                    {(l.qty * l.unitPrice).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  <div className="py-1 pr-2">
                    <select className="w-full h-6 px-0 text-[11px] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]"
                            value={l.itemGroup}
                            onChange={(e) => updateLine(l.uid, { itemGroup: e.target.value as ItemGroup })}>
                      {ITEM_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </div>
                  <div className="py-1 flex items-center justify-center">
                    <button onClick={() => removeLine(l.uid)}
                            disabled={lines.length <= 1}
                            className="h-5 w-5 rounded flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50"
                            title="Remove">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
              <div className="grid grid-cols-[40px_2fr_2fr_70px_90px_100px_90px_30px] text-[12px] font-semibold pt-2">
                <div className="col-span-5 text-right text-gray-500">Subtotal</div>
                <div className="text-right tabular-nums text-[#0A1F2E]">
                  {subtotal.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="col-span-2" />
              </div>
            </div>
            <datalist id="newso-skus">
              {skus.slice(0, 1500).map((s) => (
                <option key={s.id} value={s.itemCode}>{s.description}</option>
              ))}
            </datalist>
          </div>

          {/* Remarks + Total (order-level) */}
          <div className="mt-4 max-w-[520px] space-y-1">
            <Row label="Remarks" icon={<FileText className="h-3 w-3" />}>
              <Inp value={orderRemarks} onChange={(e) => setOrderRemarks(e.target.value)} placeholder="—" />
            </Row>
            <Row label="Total" icon={<DollarSign className="h-3 w-3" />}>
              <span className="text-[13px] text-[#0A1F2E] tabular-nums font-semibold">
                {subtotal.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </Row>
          </div>

          {/* Payments section — mirrors Inistate */}
          <div className="mt-5">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="h-3.5 w-3.5 text-gray-500" />
              <span className="text-[12px] text-gray-500">Payments</span>
              <button onClick={addPayment}
                      className="ml-auto h-6 px-2 rounded border border-[#E5E7EB] bg-white text-[11px] text-gray-600 hover:border-[#0F766E] hover:text-[#0F766E] inline-flex items-center gap-1">
                <Plus className="h-3 w-3" /> Add Payment
              </button>
            </div>
            <div className="border-t border-[#E5E7EB]">
              <div className="grid grid-cols-[140px_130px_110px_1fr_1fr_140px_30px] text-[11px] text-[#9CA3AF]">
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Date <CalIcon className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Payment Method <Tag className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] text-right inline-flex items-center justify-end gap-1">Amount <DollarSign className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Account Sheet <FileText className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Approval Code <FileText className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB] inline-flex items-center gap-1">Collected By <UserIcon className="h-3 w-3" /></div>
                <div className="py-2 border-b border-[#E5E7EB]" />
              </div>
              {payments.length === 0 && (
                <div className="py-3 text-center text-[11px] text-gray-400">
                  No payments recorded yet · click "Add Payment" to log a deposit
                </div>
              )}
              {payments.map((p) => (
                <div key={p.uid} className="grid grid-cols-[140px_130px_110px_1fr_1fr_140px_30px] text-[12px] border-b border-[#F3F4F6] items-center hover:bg-[#FAFBFB]">
                  <div className="py-1 pr-2">
                    <input type="date" value={p.date} onChange={(e) => updatePayment(p.uid, { date: e.target.value })}
                           className="w-full h-6 px-0 text-[12px] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]" />
                  </div>
                  <div className="py-1 pr-2">
                    <select value={p.method} onChange={(e) => updatePayment(p.uid, { method: e.target.value })}
                            className="w-full h-6 px-0 text-[12px] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]">
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div className="py-1 pr-2 text-right">
                    <input type="number" min={0} step="0.01" value={p.amount}
                           onChange={(e) => updatePayment(p.uid, { amount: parseFloat(e.target.value) || 0 })}
                           className="w-full h-6 px-0 text-[12px] text-right tabular-nums bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]" />
                  </div>
                  <div className="py-1 pr-2">
                    <input value={p.accountSheet} onChange={(e) => updatePayment(p.uid, { accountSheet: e.target.value })}
                           placeholder="e.g. AKHC 3809"
                           className="w-full h-6 px-0 text-[12px] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]" />
                  </div>
                  <div className="py-1 pr-2">
                    <input value={p.approvalCode} onChange={(e) => updatePayment(p.uid, { approvalCode: e.target.value })}
                           className="w-full h-6 px-0 text-[12px] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]" />
                  </div>
                  <div className="py-1 pr-2">
                    <input value={p.collectedBy} onChange={(e) => updatePayment(p.uid, { collectedBy: e.target.value })}
                           placeholder="User"
                           className="w-full h-6 px-0 text-[12px] text-[#0F766E] bg-transparent border-0 focus:outline-none focus:border-b focus:border-[#0F766E]" />
                  </div>
                  <div className="py-1 flex items-center justify-center">
                    <button onClick={() => removePayment(p.uid)}
                            className="h-5 w-5 rounded flex items-center justify-center text-gray-300 hover:text-red-500 hover:bg-red-50" title="Remove">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Deposit Paid + Balance totals (mirror Inistate) */}
            <div className="max-w-[380px] mt-3 ml-auto space-y-1">
              <Row label="Deposit Paid" icon={<DollarSign className="h-3 w-3" />}>
                <span className="text-[13px] tabular-nums text-[#0A1F2E]">
                  {depositPaid.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </Row>
              <Row label="Balance" icon={<DollarSign className="h-3 w-3" />}>
                <span className={`text-[13px] tabular-nums font-semibold ${balanceOutstanding > 0 ? "text-red-600" : "text-[#0F766E]"}`}>
                  {balanceOutstanding.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </Row>
            </div>
          </div>
        </div>

        {/* Footer — Update Details | Cancel | Sales Order */}
        <div className="flex items-center gap-2 px-6 py-3 border-t border-[#E5E7EB] bg-white">
          <div className="mr-auto text-[12px] text-gray-500 inline-flex items-center gap-3">
            <span>{lines.filter((l) => l.itemCode).length} line(s)</span>
            <span>Total: <span className="font-semibold text-[#0A1F2E] tabular-nums">RM {subtotal.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></span>
            <span>Paid: <span className="font-semibold text-[#0F766E] tabular-nums">RM {depositPaid.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></span>
            <span>Balance: <span className={`font-semibold tabular-nums ${balanceOutstanding > 0 ? "text-red-600" : "text-[#0F766E]"}`}>RM {balanceOutstanding.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></span>
          </div>
          <button onClick={submit}
                  className="h-8 px-3 rounded bg-[#0F766E] text-white text-[12px] font-semibold hover:bg-[#0D6B63] inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5" /> Update Details
          </button>
          <button onClick={onClose}
                  className="h-8 px-3 rounded border border-[#E5E7EB] bg-white text-[12px] font-semibold text-gray-600 hover:border-gray-400">
            Cancel
          </button>
          <button onClick={submit}
                  className="h-8 px-3 rounded border border-[#0F766E] bg-white text-[12px] font-semibold text-[#0F766E] hover:bg-[#F0F9F7] inline-flex items-center gap-1.5">
            <ShoppingCart className="h-3.5 w-3.5" /> Sales Order
          </button>
        </div>
      </div>
    </div>
  );
}
