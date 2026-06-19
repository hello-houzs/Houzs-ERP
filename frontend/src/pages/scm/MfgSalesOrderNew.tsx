// ----------------------------------------------------------------------------
// MfgSalesOrderNew — full-page Create Sales Order at /scm/sales-orders/new.
//
// Ported from 2990's SalesOrderNew.tsx (the 4 header cards: Customer / Order
// Info / Emergency / Delivery Address + Line Items + subtotal) and rebuilt in
// Houzs Tailwind primitives. NO 2990 CSS modules / design-system.
//
// Pricing is SERVER-SIDE: each line carries an operator-typed unitPriceCenti +
// the verbatim variant build; POST /api/scm/mfg-sales-orders recomputes prices,
// stamps description2 + price columns, and returns { docNo }.
//
// Ported from 2990 (this batch): a multi-row Payments table (replaces the
// single inline Deposit), the master-follower variant cascade, and the
// per-line delivery-date cascade.
//
// Still deferred (see the build notes in the PR): per-line photos (the SCM
// photo endpoint needs a multipart two-step upload + index-match against
// server-split sofa lines — not clean enough yet), copy-from-SO, and
// scan-prefill.
//
// Payments deviation: the SCM POST books a deposit slip-less ONLY via the
// legacy header fields (one ledger row). The strict payments[]/per-doc routes
// require a per-payment slip and SCM mounts no slip-upload endpoint, so the
// multi-row drafts collapse to the single legacy deposit on submit (method =
// first row, deposit = Σ rows). See draftsToCreatePayment + the submit guard.
//
// v1 simplifications: customer-type / building-type / relationship option
// arrays are hardcoded (no venues / localities / dropdown-options endpoints
// exist); salesperson is plain text; sales location is a warehouse picker.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Save } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { Button } from "../../components/Button";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { api } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { Field, Input } from "./Suppliers";
import {
  emptySoLine,
  missingRequiredVariants,
  type SoLineDraft,
  type ResolvedMaintConfig,
} from "./mfgSalesOrderShared";
import {
  SoLineCard,
  TODAY,
  type SpecialAddonRow,
  type FabricTrackingRow,
  type FabricOption,
} from "./SoLineCard";
import {
  PaymentsTable,
  draftsToCreatePayment,
  type PaymentDraft,
} from "./PaymentsTable";

// ── Hardcoded option arrays (no maintenance endpoints for these in v1) ───────
const CUSTOMER_TYPES = ["Walk-in", "Repeat", "Referral", "Online", "Corporate", "Dealer"];
const BUILDING_TYPES = ["Apartment", "Condominium", "Landed", "Terrace", "Bungalow", "Shop", "Office"];
const RELATIONSHIPS = ["Spouse", "Parent", "Child", "Sibling", "Relative", "Friend", "Colleague"];

// ── Picker shapes ────────────────────────────────────────────────────────────
interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}
// GET /api/scm/mfg-sales-orders/customer-search?name= → { customers: [...] }
// (server camelCases these via its byKey map).
interface CustomerSuggestion {
  debtorName: string | null;
  phone: string | null;
  email: string | null;
  customerType: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  postcode: string | null;
  customerState: string | null;
  buildingType: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelationship: string | null;
}

type DraftLine = SoLineDraft & { rid: string };
let ridCounter = 0;
function newLine(deliveryDate: string | null = null): DraftLine {
  ridCounter += 1;
  return {
    ...emptySoLine(),
    lineDeliveryDate: deliveryDate,
    lineDeliveryDateOverridden: false,
    rid: `l${ridCounter}-${Math.random().toString(36).slice(2, 7)}`,
  };
}

const selectCls =
  "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20";
const dateCls = selectCls;

export function ScmMfgSalesOrderNew() {
  const navigate = useNavigate();
  const toast = useToast();
  const dialog = useDialog();

  // ── Customer ──────────────────────────────────────────────────────────
  const [debtorName, setDebtorName] = useState("");
  const [debtorCode, setDebtorCode] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [customerType, setCustomerType] = useState("");
  const [customerSoNo, setCustomerSoNo] = useState("");
  const [showSuggest, setShowSuggest] = useState(false);

  // ── Order Info ────────────────────────────────────────────────────────
  const [salesLocation, setSalesLocation] = useState("");
  const [salesperson, setSalesperson] = useState("");
  const [processingDate, setProcessingDate] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [note, setNote] = useState("");

  // ── Emergency ─────────────────────────────────────────────────────────
  const [emergencyName, setEmergencyName] = useState("");
  const [emergencyRel, setEmergencyRel] = useState("");
  const [emergencyPhone, setEmergencyPhone] = useState("");

  // ── Delivery address ──────────────────────────────────────────────────
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [postcode, setPostcode] = useState("");
  const [buildingType, setBuildingType] = useState("");

  // ── Payments (multi-row draft editor) ─────────────────────────────────
  const [paymentDrafts, setPaymentDrafts] = useState<PaymentDraft[]>([]);

  // ── Lines ─────────────────────────────────────────────────────────────
  const [lines, setLines] = useState<DraftLine[]>(() => [newLine()]);
  const [saving, setSaving] = useState(false);

  // ── Shared pools (fetched once, passed to every line card) ────────────
  const maintQ = useQuery<{ data: ResolvedMaintConfig | null }>(
    () => api.get(`${SCM}/maintenance-config/resolved?scope=master`),
    [],
  );
  const specialsQ = useQuery<{ addons: SpecialAddonRow[] }>(
    () => api.get(`${SCM}/special-addons`),
    [],
  );
  const fabricsQ = useQuery<{ fabrics: FabricTrackingRow[] }>(
    () => api.get(`${SCM}/fabric-tracking`),
    [],
  );
  const warehousesQ = useQuery<{ warehouses: WarehouseOption[] }>(
    () => api.get(`${SCM}/inventory/warehouses`),
    [],
  );

  const maint = maintQ.data?.data ?? null;
  const specialDefs = useMemo(() => specialsQ.data?.addons ?? [], [specialsQ.data]);
  const warehouses = warehousesQ.data?.warehouses ?? [];

  // Build the fabric colour picker from fabric-tracking. NOTE (deviation): no
  // GET for the selling-side fabric_colours / fabric_library exists in the SCM
  // routes, so the picker sources the cost ledger directly. DUAL-READ
  // camelCase ?? snake_case. Inactive fabrics (is_active === false) are hidden.
  const fabricOptions: FabricOption[] = useMemo(() => {
    const rows = fabricsQ.data?.fabrics ?? [];
    return rows
      .filter((f) => (f.is_active ?? true) !== false)
      .map((f) => {
        const code = f.fabricCode ?? f.fabric_code;
        const desc = (f.fabric_description ?? "").trim();
        const ext = (f.supplierCode ?? f.supplier_code ?? "").trim();
        const codePart = ext ? `${code} · ${ext}` : code;
        return {
          value: code,
          display: desc ? `${codePart} — ${desc}` : codePart,
        };
      });
  }, [fabricsQ.data]);

  // ── Customer autocomplete ─────────────────────────────────────────────
  const custName = debtorName.trim();
  const custSearchActive = custName.length >= 2;
  const customerQ = useQuery<{ customers: CustomerSuggestion[] }>(
    () =>
      custSearchActive
        ? api.get(
            `${SCM}/mfg-sales-orders/customer-search?name=${encodeURIComponent(custName)}`,
          )
        : Promise.resolve({ customers: [] }),
    [custSearchActive ? custName : ""],
  );
  const suggestions = custSearchActive ? customerQ.data?.customers ?? [] : [];

  function applySuggestion(s: CustomerSuggestion) {
    setDebtorName(s.debtorName ?? "");
    setPhone(s.phone ?? "");
    setEmail(s.email ?? "");
    setCustomerType(s.customerType ?? "");
    setAddress1(s.address1 ?? "");
    setAddress2(s.address2 ?? "");
    setState(s.customerState ?? "");
    setCity(s.city ?? "");
    setPostcode(s.postcode ?? "");
    setEmergencyName(s.emergencyContactName ?? "");
    setEmergencyRel(s.emergencyContactRelationship ?? "");
    setEmergencyPhone(s.emergencyContactPhone ?? "");
    setShowSuggest(false);
  }

  // ── Line helpers ──────────────────────────────────────────────────────
  function updateLine(rid: string, patch: Partial<SoLineDraft>) {
    setLines((prev) => prev.map((l) => (l.rid === rid ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, newLine(deliveryDate || null)]);
  }
  async function dropLine(rid: string) {
    const line = lines.find((l) => l.rid === rid);
    const hasData = line && (line.itemCode.trim() || line.unitPriceCenti > 0);
    if (hasData) {
      const ok = await dialog.confirm({
        title: "Remove this line?",
        message:
          "The item, quantity, price and variant selections on this line will be discarded.",
        confirmLabel: "Remove line",
        danger: true,
      });
      if (!ok) return;
    }
    setLines((prev) => {
      const next = prev.filter((l) => l.rid !== rid);
      return next.length ? next : [newLine(deliveryDate || null)];
    });
  }

  // ── Per-line delivery-date cascade ────────────────────────────────────
  // The header Delivery Date flows to every line's lineDeliveryDate unless that
  // line was manually overridden. Mirrors the server-side cascade the create
  // route applies (explicit line date wins, else inherit header).
  useEffect(() => {
    const target = deliveryDate || null;
    setLines((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        if (l.lineDeliveryDateOverridden) return l;
        if ((l.lineDeliveryDate ?? null) === target) return l;
        changed = true;
        return { ...l, lineDeliveryDate: target };
      });
      return changed ? next : prev;
    });
  }, [deliveryDate]);

  // ── Master-follower variant cascade ───────────────────────────────────
  // The FIRST line of each category (the "master") drives variant values on
  // later same-category lines, EXCEPT keys a follower has manually overridden
  // (tracked in overriddenKeys). Pure state — recomputed whenever lines change.
  useEffect(() => {
    const masterByCategory: Record<string, Record<string, unknown>> = {};
    const masterIdx: Record<string, number> = {};
    lines.forEach((l, idx) => {
      const cat = l.itemGroup;
      if (!cat) return;
      if (masterIdx[cat] !== undefined) return;
      masterIdx[cat] = idx;
      if (l.variants) masterByCategory[cat] = l.variants;
    });

    let changed = false;
    const next = lines.map((l, idx) => {
      const cat = l.itemGroup;
      if (!cat) return l;
      if (masterIdx[cat] === idx) return l; // this IS the master
      const masterVariants = masterByCategory[cat];
      if (!masterVariants) return l;
      const cur = l.variants ?? {};
      const overridden = new Set(l.overriddenKeys ?? []);
      const patch: Record<string, unknown> = {};
      let hasChange = false;
      for (const k of Object.keys(masterVariants)) {
        if (overridden.has(k)) continue;
        const masterVal = masterVariants[k];
        if (masterVal === undefined || masterVal === null || masterVal === "")
          continue;
        if (cur[k] !== masterVal) {
          patch[k] = masterVal;
          hasChange = true;
        }
      }
      if (!hasChange) return l;
      changed = true;
      return { ...l, variants: { ...cur, ...patch } };
    });
    if (changed) setLines(next);
  }, [lines]);

  // The variants of the FIRST line of each category that has any set — seeds a
  // freshly-picked same-category follower line (see SoLineCard.pickProduct).
  const inheritVariantsByCategory = useMemo(() => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const l of lines) {
      const cat = l.itemGroup;
      if (!cat || out[cat]) continue;
      if (l.variants && Object.keys(l.variants).length > 0) out[cat] = l.variants;
    }
    return out;
  }, [lines]);

  async function removePaymentRow(uid: string) {
    const row = paymentDrafts.find((d) => d.uid === uid);
    if (row && row.amountCenti > 0) {
      const ok = await dialog.confirm({
        title: "Remove this payment?",
        message: `This payment row of ${fmtCenti(row.amountCenti)} will be discarded.`,
        confirmLabel: "Remove payment",
        danger: true,
      });
      if (!ok) return;
    }
    setPaymentDrafts((prev) => prev.filter((d) => d.uid !== uid));
  }

  const subtotalCenti = useMemo(
    () =>
      lines.reduce(
        (s, l) => s + Math.max(0, l.qty * l.unitPriceCenti - l.discountCenti),
        0,
      ),
    [lines],
  );

  const createPayment = useMemo(
    () => draftsToCreatePayment(paymentDrafts),
    [paymentDrafts],
  );
  const depositCenti = createPayment?.depositCenti ?? 0;

  // Processing/Delivery dates must both be set or both empty (mirrors the
  // server's processing_delivery_must_pair 400).
  const datesXor =
    (processingDate.trim() !== "") !== (deliveryDate.trim() !== "");

  // ── Save ──────────────────────────────────────────────────────────────
  async function submit() {
    if (!debtorName.trim()) {
      toast.error("Customer name is required");
      return;
    }
    if (!phone.trim()) {
      toast.error("Phone number is required on every sales order");
      return;
    }
    if (datesXor) {
      toast.error("Processing Date and Delivery Date must be set together");
      return;
    }
    if (processingDate && processingDate < TODAY) {
      toast.error("Processing Date cannot be in the past");
      return;
    }
    if (deliveryDate && deliveryDate < TODAY) {
      toast.error("Delivery Date cannot be in the past");
      return;
    }
    if (processingDate && deliveryDate && processingDate > deliveryDate) {
      toast.error("Processing Date cannot be later than the Delivery Date");
      return;
    }

    const validLines = lines.filter((l) => l.itemCode.trim() && l.qty > 0);
    if (validLines.length === 0) {
      toast.error('Add at least one item via "Add Line Item"');
      return;
    }

    // Variants are mandatory ONLY once a processing date is set — that's when
    // the order commits to production (matches the server's 409 gate).
    if (processingDate) {
      const gaps = validLines
        .map((l) => ({
          code: l.itemCode,
          miss: missingRequiredVariants(l.itemGroup, l.variants),
        }))
        .filter((x) => x.miss.length > 0);
      if (gaps.length > 0) {
        toast.error(
          "Complete all variant selections: " +
            gaps.map((g) => `${g.code} (${g.miss.join(", ")})`).join("; "),
        );
        return;
      }
    }

    // Deposit may not exceed the order total (the server rejects overpayment
    // on the ledger row; fail fast here with a friendlier message).
    if (depositCenti > subtotalCenti) {
      toast.error(
        `Deposit (${fmtCenti(depositCenti)}) exceeds the order total (${fmtCenti(subtotalCenti)})`,
      );
      return;
    }
    // The slip-less create path books ONE deposit row, so split rows with
    // differing methods can't all be recorded — warn (don't block) the
    // operator that only the first row's method is booked on the header.
    if (createPayment?.mixedMethods) {
      const ok = await dialog.confirm({
        title: "Multiple payment methods",
        message:
          "Only one payment method can be recorded at create time — the first " +
          "row's method is used and the amounts are combined into a single " +
          "deposit. Add the remaining payments individually on the SO detail " +
          "page after it's created.\n\nCreate the order this way?",
        confirmLabel: "Create order",
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      const res = await api.post<{ docNo: string }>(
        `${SCM}/mfg-sales-orders`,
        {
          debtorName: debtorName.trim(),
          debtorCode: debtorCode.trim() || undefined,
          phone: phone.trim(),
          email: email.trim() || undefined,
          customerType: customerType || undefined,
          customerSoNo: customerSoNo.trim() || undefined,
          salesLocation: salesLocation || undefined,
          salesperson: salesperson.trim() || undefined,
          address1: address1.trim() || undefined,
          address2: address2.trim() || undefined,
          customerState: state.trim() || undefined,
          city: city.trim() || undefined,
          postcode: postcode.trim() || undefined,
          buildingType: buildingType || undefined,
          emergencyContactName: emergencyName.trim() || undefined,
          emergencyContactRelationship: emergencyRel || undefined,
          emergencyContactPhone: emergencyPhone.trim() || undefined,
          internalExpectedDd: processingDate || undefined,
          customerDeliveryDate: deliveryDate || undefined,
          note: note.trim() || undefined,
          // Payments — slip-less legacy deposit fields (see PaymentsTable's
          // draftsToCreatePayment + the file-header deviation note). The server
          // books a single is_deposit ledger row from these.
          depositCenti: createPayment ? createPayment.depositCenti : undefined,
          paymentMethod: createPayment?.paymentMethod,
          merchantProvider: createPayment?.merchantProvider,
          installmentMonths: createPayment?.installmentMonths,
          approvalCode: createPayment?.approvalCode,
          paymentDate: createPayment?.paymentDate,
          items: validLines.map((l) => ({
            itemGroup: l.itemGroup,
            itemCode: l.itemCode,
            description: l.description,
            uom: l.uom,
            qty: l.qty,
            unitPriceCenti: l.unitPriceCenti,
            discountCenti: l.discountCenti,
            unitCostCenti: l.unitCostCenti,
            variants: l.variants,
            remark: l.remark,
            lineDeliveryDate: l.lineDeliveryDate ?? null,
            lineDeliveryDateOverridden: l.lineDeliveryDateOverridden ?? false,
          })),
        },
      );
      toast.success(`Sales order ${res.docNo} created`);
      navigate(`/scm/sales-orders/${encodeURIComponent(res.docNo)}`);
    } catch (e) {
      const msg = String((e as Error)?.message ?? "");
      toast.error(`Failed to create sales order${msg ? `: ${msg}` : ""}`);
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={() => navigate("/scm/sales-orders")}
        className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} />
        Sales Orders
      </button>

      <PageHeader
        eyebrow="Supply Chain"
        title="New Sales Order"
        description="Raise a customer sales order — sofa / bedframe / mattress build lines."
        primaryAction={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => navigate("/scm/sales-orders")}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button icon={<Save size={15} />} onClick={submit} disabled={saving}>
              {saving ? "Saving…" : "Create Sales Order"}
            </Button>
          </div>
        }
      />

      {/* ── Customer ─────────────────────────────────────────────────── */}
      <Card title="Customer">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="relative sm:col-span-2">
            <Field label="Customer Name" required>
              <input
                className={selectCls}
                value={debtorName}
                onChange={(e) => {
                  setDebtorName(e.target.value);
                  setShowSuggest(true);
                }}
                onFocus={() => setShowSuggest(true)}
                onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
                placeholder="e.g. Lim Mei Hua"
              />
            </Field>
            {showSuggest && suggestions.length > 0 && (
              <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-surface py-1 shadow-lg">
                {suggestions.slice(0, 8).map((s, i) => (
                  <li key={`${s.debtorName ?? ""}-${i}`}>
                    <button
                      type="button"
                      className="block w-full px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-accent-soft"
                      onMouseDown={() => applySuggestion(s)}
                    >
                      <span className="font-medium">{s.debtorName}</span>
                      {s.phone && (
                        <span className="ml-2 text-[11px] text-ink-muted">
                          {s.phone}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Field label="Customer SO Ref">
            <Input
              value={customerSoNo}
              onChange={setCustomerSoNo}
              placeholder="Their PO / SO number"
            />
          </Field>
          <Field label="Phone" required>
            <input
              type="tel"
              className={selectCls}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="01x-xxxxxxx"
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              className={selectCls}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@example.com"
            />
          </Field>
          <Field label="Debtor Code">
            <Input
              value={debtorCode}
              onChange={setDebtorCode}
              placeholder="AutoCount code (optional)"
            />
          </Field>
          <Field label="Customer Type">
            <select
              className={selectCls}
              value={customerType}
              onChange={(e) => setCustomerType(e.target.value)}
            >
              <option value="">—</option>
              {CUSTOMER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      {/* ── Order Info ───────────────────────────────────────────────── */}
      <Card title="Order Info">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Sales Location">
            <select
              className={selectCls}
              value={salesLocation}
              onChange={(e) => setSalesLocation(e.target.value)}
            >
              <option value="">— Pick a warehouse —</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.code}>
                  {w.code} · {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Salesperson">
            <Input
              value={salesperson}
              onChange={setSalesperson}
              placeholder="Staff name (optional)"
            />
          </Field>
          <Field label="Note">
            <Input
              value={note}
              onChange={setNote}
              placeholder="Internal notes — SO detail only"
            />
          </Field>
          <Field label="Processing Date">
            <input
              type="date"
              className={dateCls}
              value={processingDate}
              min={TODAY}
              onChange={(e) => setProcessingDate(e.target.value)}
            />
          </Field>
          <Field label="Delivery Date">
            <input
              type="date"
              className={dateCls}
              value={deliveryDate}
              min={TODAY}
              onChange={(e) => setDeliveryDate(e.target.value)}
            />
          </Field>
        </div>
        {datesXor && (
          <p className="mt-2 rounded-md border border-err/40 bg-err/5 px-3 py-1.5 text-[12px] font-semibold text-err">
            Processing Date and Delivery Date must be set together — fill in both
            or leave both empty.
          </p>
        )}
      </Card>

      {/* ── Emergency Contact ────────────────────────────────────────── */}
      <Card
        title="Emergency Contact"
        subtitle="Used only if we cannot reach the customer on delivery day"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Contact Name">
            <Input
              value={emergencyName}
              onChange={setEmergencyName}
              placeholder="e.g. Lim Ah Kau"
            />
          </Field>
          <Field label="Relationship">
            <select
              className={selectCls}
              value={emergencyRel}
              onChange={(e) => setEmergencyRel(e.target.value)}
            >
              <option value="">—</option>
              {RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Phone">
            <input
              type="tel"
              className={selectCls}
              value={emergencyPhone}
              onChange={(e) => setEmergencyPhone(e.target.value)}
              placeholder="01x-xxxxxxx"
            />
          </Field>
        </div>
      </Card>

      {/* ── Delivery Address ─────────────────────────────────────────── */}
      <Card title="Delivery Address">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="Address Line 1">
              <Input
                value={address1}
                onChange={setAddress1}
                placeholder="Unit, street, area"
              />
            </Field>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="Address Line 2">
              <Input
                value={address2}
                onChange={setAddress2}
                placeholder="Apt, floor, building (optional)"
              />
            </Field>
          </div>
          <Field label="State">
            <Input value={state} onChange={setState} placeholder="e.g. Selangor" />
          </Field>
          <Field label="City">
            <Input value={city} onChange={setCity} placeholder="e.g. Petaling Jaya" />
          </Field>
          <Field label="Postcode">
            <Input value={postcode} onChange={setPostcode} placeholder="e.g. 46200" />
          </Field>
          <Field label="Building Type">
            <select
              className={selectCls}
              value={buildingType}
              onChange={(e) => setBuildingType(e.target.value)}
            >
              <option value="">—</option>
              {BUILDING_TYPES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      {/* ── Line Items ───────────────────────────────────────────────── */}
      <div className="mb-2 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Line Items ({lines.length})
        </h3>
      </div>

      <div className="space-y-3">
        {lines.map((line, idx) => (
          <SoLineCard
            key={line.rid}
            index={idx}
            draft={line}
            onChange={(patch) => updateLine(line.rid, patch)}
            onRemove={() => dropLine(line.rid)}
            canRemove={lines.length > 1}
            maint={maint}
            specialDefs={specialDefs}
            fabricOptions={fabricOptions}
            inheritVariantsByCategory={inheritVariantsByCategory}
          />
        ))}

        <button
          type="button"
          onClick={addLine}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-accent/50 px-4 py-3 text-[13px] font-semibold text-accent transition-colors hover:bg-accent-soft"
        >
          <Plus size={15} /> Add Line Item
        </button>
      </div>

      {/* ── Subtotal ─────────────────────────────────────────────────── */}
      <div className="mt-5 flex justify-end">
        <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="flex items-center justify-between text-[13px] text-ink-secondary">
            <span>Subtotal</span>
            <span className="font-mono text-ink">{fmtCenti(subtotalCenti)}</span>
          </div>
          {depositCenti > 0 && (
            <div className="mt-1 flex items-center justify-between text-[13px] text-ink-secondary">
              <span>Deposit Paid</span>
              <span className="font-mono text-ink">{fmtCenti(depositCenti)}</span>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between border-t border-border-subtle pt-2 text-[15px] font-bold text-ink">
            <span>Total</span>
            <span className="font-mono">{fmtCenti(subtotalCenti)}</span>
          </div>
          <p className="mt-2 text-[11px] text-ink-muted">
            Final line prices are recomputed on the server from the build spec
            when you create the order.
          </p>
        </div>
      </div>

      {/* ── Payments ─────────────────────────────────────────────────── */}
      <div className="mt-5">
        <PaymentsTable
          drafts={paymentDrafts}
          onChange={setPaymentDrafts}
          grandTotalCenti={subtotalCenti}
          onRemoveRow={removePaymentRow}
        />
      </div>

      {/* Footer save (mirrors the header action on long forms). */}
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => navigate("/scm/sales-orders")}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button icon={<Save size={15} />} onClick={submit} disabled={saving}>
          {saving ? "Saving…" : "Create Sales Order"}
        </Button>
      </div>
    </div>
  );
}

// ── Section card ─────────────────────────────────────────────────────────────
function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5 rounded-lg border border-border bg-surface p-5 shadow-stone">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-px w-3 bg-accent/60" />
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          {title}
        </h3>
        {subtitle && (
          <span className="text-[11px] normal-case text-ink-muted">· {subtitle}</span>
        )}
      </div>
      {children}
    </div>
  );
}
