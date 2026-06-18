import { useMemo, useState } from "react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api } from "../../api/client";
import { SCM, fmtCenti } from "../../lib/scm";
import { cn } from "../../lib/utils";

// ----------------------------------------------------------------------------
// Outstanding — receivables / payables outstanding documents.
//
// 2990's Outstanding page tabs across 8 modules (PO/GRN/PI/PR/SO/DO/SI) backed
// by `/outstanding/{module}` + `/outstanding/summary`. Those endpoints are NOT
// mounted in the Houzs SCM backend (no outstanding.ts route). The only
// outstanding views the Houzs backend exposes are the AR / AP aging views
// (`/accounting/ar-aging`, `/accounting/ap-aging`) — the open SI (receivable)
// and open PI (payable) documents with their outstanding balance + aging
// bucket. So this page is a chip-switch over those two backed views, mirroring
// 2990's tabbed structure as closely as the live backend allows.
//
// Backed endpoints:
//   GET /api/scm/accounting/ar-aging  → { arAging: ArAgingRow[] }
//   GET /api/scm/accounting/ap-aging  → { apAging: ApAgingRow[] }
// ----------------------------------------------------------------------------

type AgingBucket = "CURRENT" | "1-30" | "31-60" | "61-90" | "90+";

interface ArAgingRow {
  invoice_id: string;
  invoice_number: string;
  debtor_code: string | null;
  debtor_name: string;
  invoice_date: string;
  due_date: string | null;
  total_centi: number;
  paid_centi: number;
  outstanding_centi: number;
  days_overdue: number;
  aging_bucket: AgingBucket;
  status: string;
}

interface ApAgingRow {
  invoice_id: string;
  invoice_number: string;
  supplier_invoice_ref: string | null;
  supplier_id: string;
  supplier_code: string | null;
  supplier_name: string | null;
  invoice_date: string;
  due_date: string | null;
  total_centi: number;
  paid_centi: number;
  outstanding_centi: number;
  days_overdue: number;
  aging_bucket: AgingBucket;
  status: string;
}

// A normalised row so AR + AP share one table shape (party = customer/supplier).
interface OutRow {
  id: string;
  invoice_number: string;
  party_label: string;
  invoice_date: string;
  due_date: string | null;
  total_centi: number;
  paid_centi: number;
  outstanding_centi: number;
  days_overdue: number;
  aging_bucket: AgingBucket;
  status: string;
}

const TABS = [
  { value: "ar", label: "AR — Receivable" },
  { value: "ap", label: "AP — Payable" },
] as const;
type Tab = (typeof TABS)[number]["value"];

const MODES = [
  { value: "outstanding", label: "Outstanding" },
  { value: "overdue", label: "Overdue" },
  { value: "all", label: "All" },
] as const;
type Mode = (typeof MODES)[number]["value"];

function fmtDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "—";
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-stone">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-1 font-display text-[22px] font-bold tracking-tight text-ink">{value}</div>
      {sub && <div className="text-[11px] text-ink-muted">{sub}</div>}
    </div>
  );
}

function BucketPill({ bucket }: { bucket: AgingBucket }) {
  const cls =
    bucket === "CURRENT"
      ? "bg-synced/15 text-synced border-synced/30"
      : bucket === "1-30"
        ? "bg-warning-bg text-warning-text border-warning-text/30"
        : bucket === "31-60"
          ? "bg-warning-bg text-warning-text border-warning-text/40"
          : "bg-err/10 text-err border-err/30";
  return (
    <span className={cn("inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold", cls)}>
      {bucket}
    </span>
  );
}

export function ScmOutstanding() {
  const [tab, setTab] = useState<Tab>("ar");
  const [mode, setMode] = useState<Mode>("outstanding");
  const [search, setSearch] = useState("");

  const ar = useQuery<{ arAging: ArAgingRow[] }>(() => api.get(`${SCM}/accounting/ar-aging`), []);
  const ap = useQuery<{ apAging: ApAgingRow[] }>(() => api.get(`${SCM}/accounting/ap-aging`), []);

  const active = tab === "ar" ? ar : ap;

  // Normalise the active view into a single row shape.
  const allRows: OutRow[] | null = useMemo(() => {
    if (tab === "ar") {
      if (!ar.data) return null;
      return ar.data.arAging.map((r) => ({
        id: r.invoice_id,
        invoice_number: r.invoice_number,
        party_label: r.debtor_code ? `${r.debtor_name} (${r.debtor_code})` : r.debtor_name,
        invoice_date: r.invoice_date,
        due_date: r.due_date,
        total_centi: r.total_centi,
        paid_centi: r.paid_centi,
        outstanding_centi: r.outstanding_centi,
        days_overdue: r.days_overdue,
        aging_bucket: r.aging_bucket,
        status: r.status,
      }));
    }
    if (!ap.data) return null;
    return ap.data.apAging.map((r) => ({
      id: r.invoice_id,
      invoice_number: r.invoice_number,
      party_label: r.supplier_code ? `${r.supplier_name ?? "—"} (${r.supplier_code})` : r.supplier_name ?? "—",
      invoice_date: r.invoice_date,
      due_date: r.due_date,
      total_centi: r.total_centi,
      paid_centi: r.paid_centi,
      outstanding_centi: r.outstanding_centi,
      days_overdue: r.days_overdue,
      aging_bucket: r.aging_bucket,
      status: r.status,
    }));
  }, [tab, ar.data, ap.data]);

  // Mode filter — outstanding (balance > 0), overdue (days_overdue > 0), or all.
  const rows = useMemo(() => {
    if (!allRows) return allRows;
    let r = allRows;
    if (mode === "outstanding") r = r.filter((x) => x.outstanding_centi > 0);
    else if (mode === "overdue") r = r.filter((x) => x.days_overdue > 0);
    const q = search.trim().toLowerCase();
    if (q) {
      r = r.filter(
        (x) => x.invoice_number.toLowerCase().includes(q) || x.party_label.toLowerCase().includes(q),
      );
    }
    return r;
  }, [allRows, mode, search]);

  const stats = useMemo(() => {
    const r = rows ?? [];
    return {
      count: r.length,
      outstanding: r.reduce((s, x) => s + x.outstanding_centi, 0),
      overdue: r.filter((x) => x.days_overdue > 0).reduce((s, x) => s + x.outstanding_centi, 0),
    };
  }, [rows]);

  const partyLabel = tab === "ar" ? "Customer" : "Supplier";

  const columns: Column<OutRow>[] = [
    {
      key: "invoice_number",
      label: "Invoice",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-ink">{r.invoice_number}</span>,
      getValue: (r) => r.invoice_number,
    },
    { key: "party_label", label: partyLabel, render: (r) => r.party_label, getValue: (r) => r.party_label },
    { key: "invoice_date", label: "Date", render: (r) => fmtDate(r.invoice_date), getValue: (r) => r.invoice_date },
    { key: "due_date", label: "Due", render: (r) => fmtDate(r.due_date), getValue: (r) => r.due_date || "" },
    {
      key: "total_centi",
      label: "Total",
      align: "right",
      defaultHidden: true,
      render: (r) => <span className="font-mono">{fmtCenti(r.total_centi)}</span>,
      getValue: (r) => r.total_centi,
    },
    {
      key: "paid_centi",
      label: "Paid",
      align: "right",
      defaultHidden: true,
      render: (r) => <span className="font-mono">{fmtCenti(r.paid_centi)}</span>,
      getValue: (r) => r.paid_centi,
    },
    {
      key: "outstanding_centi",
      label: "Outstanding",
      align: "right",
      render: (r) => <span className="font-mono font-semibold">{fmtCenti(r.outstanding_centi)}</span>,
      getValue: (r) => r.outstanding_centi,
    },
    {
      key: "days_overdue",
      label: "Overdue",
      align: "right",
      render: (r) => (r.days_overdue > 0 ? `${r.days_overdue}d` : "—"),
      getValue: (r) => r.days_overdue,
    },
    {
      key: "aging_bucket",
      label: "Bucket",
      render: (r) => <BucketPill bucket={r.aging_bucket} />,
      getValue: (r) => r.aging_bucket,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Outstanding"
        description="Open receivable (SI) and payable (PI) documents with outstanding balance and aging bucket."
      />

      {/* Module chips — AR / AP */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={cn(
              "rounded-md border px-3 py-1 text-[12px] font-semibold transition-colors",
              tab === t.value
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Summary tiles */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Kpi label="Documents" value={stats.count.toLocaleString("en-MY")} />
        <Kpi label="Outstanding" value={fmtCenti(stats.outstanding)} />
        <Kpi label="Overdue" value={fmtCenti(stats.overdue)} sub="past due date" />
      </div>

      {/* Mode filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.value}
            onClick={() => setMode(m.value)}
            className={cn(
              "rounded-md border px-3 py-1 text-[12px] font-semibold transition-colors",
              mode === m.value
                ? "border-accent bg-accent-soft text-accent"
                : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      <DataTable
        tableId={`scm_outstanding_${tab}`}
        columns={columns}
        rows={rows}
        loading={active.loading}
        error={active.error}
        getRowKey={(r) => r.id}
        search={{ value: search, onChange: setSearch, placeholder: `Search invoice, ${partyLabel.toLowerCase()}…` }}
        emptyLabel="No documents match the filters"
        exportName={`outstanding-${tab}`}
      />
    </div>
  );
}
