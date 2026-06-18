import { useMemo, useState } from "react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { api, buildQuery } from "../../api/client";
import { SCM, fmtCenti, scmStatusClasses } from "../../lib/scm";
import { cn } from "../../lib/utils";

// ── Response shapes (snake_case, verbatim from backend/src/scm/routes/accounting.ts) ──
// Money in this layer is integer *_sen / *_centi → fmtCenti.

interface Account {
  account_code: string;
  account_name: string;
  account_type: string;
  parent_code: string | null;
  is_active: boolean;
}

interface JournalEntry {
  id: string;
  je_no: string;
  entry_date: string;
  source_type: string;
  source_doc_no: string | null;
  narration: string | null;
  total_debit_sen: number;
  total_credit_sen: number;
  posted: boolean;
  posted_at: string | null;
  reversed: boolean;
  created_at: string;
}

interface GlEntry {
  line_id: string;
  je_no: string;
  entry_date: string;
  source_type: string;
  source_doc_no: string | null;
  line_no: number;
  account_code: string;
  account_name: string;
  account_type: string;
  debit_sen: number;
  credit_sen: number;
  party_type: string | null;
  party_code: string | null;
  party_name: string | null;
  notes: string | null;
  posted: boolean;
  posted_at: string | null;
}

interface AccountBalance {
  account_code: string;
  account_name: string;
  account_type: string;
  total_debit_sen: number;
  total_credit_sen: number;
  balance_sen: number;
}

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

type AgingBucket = "CURRENT" | "1-30" | "31-60" | "61-90" | "90+";

const TABS = [
  { value: "je", label: "Journal Entries" },
  { value: "gl", label: "General Ledger" },
  { value: "balances", label: "Balances" },
  { value: "ar", label: "AR Aging" },
  { value: "ap", label: "AP Aging" },
] as const;
type Tab = (typeof TABS)[number]["value"];

const SOURCE_TYPES = [
  { value: "", label: "All sources" },
  { value: "SI", label: "SI — Sales Invoice" },
  { value: "PI", label: "PI — Purchase Invoice" },
  { value: "SI_PAYMENT", label: "SI Payment" },
  { value: "PI_PAYMENT", label: "PI Payment" },
  { value: "MANUAL", label: "Manual" },
];

const ACCOUNT_TYPE_ORDER = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

function fmtDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "—";
}

function jeStatus(r: JournalEntry): string {
  return r.reversed ? "REVERSED" : r.posted ? "POSTED" : "DRAFT";
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

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
        scmStatusClasses(status),
      )}
    >
      {status}
    </span>
  );
}

export function ScmAccounting() {
  const [tab, setTab] = useState<Tab>("je");

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Accounting"
        description="Double-entry GL — journal entries, ledger stream, trial balance, and AR / AP aging."
      />

      {/* Tab chips */}
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

      {tab === "je" && <JeTab />}
      {tab === "gl" && <GlTab />}
      {tab === "balances" && <BalancesTab />}
      {tab === "ar" && <ArAgingTab />}
      {tab === "ap" && <ApAgingTab />}
    </div>
  );
}

/* ── Journal Entries ─────────────────────────────────────────────────── */
function JeTab() {
  const [sourceType, setSourceType] = useState("");
  const [search, setSearch] = useState("");

  const list = useQuery<{ journalEntries: JournalEntry[] }>(
    () => api.get(`${SCM}/accounting/journal-entries${buildQuery({ sourceType: sourceType || undefined })}`),
    [sourceType],
  );
  const rows = list.data?.journalEntries ?? null;

  const stats = useMemo(() => {
    const r = rows ?? [];
    return {
      count: r.length,
      posted: r.filter((x) => x.posted && !x.reversed).length,
      totalDr: r.reduce((s, x) => s + (x.total_debit_sen ?? 0), 0),
    };
  }, [rows]);

  const columns: Column<JournalEntry>[] = [
    {
      key: "je_no",
      label: "JE No",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-ink">{r.je_no}</span>,
      getValue: (r) => r.je_no,
    },
    { key: "entry_date", label: "Date", render: (r) => fmtDate(r.entry_date), getValue: (r) => r.entry_date },
    { key: "source_type", label: "Source", render: (r) => r.source_type, getValue: (r) => r.source_type },
    {
      key: "source_doc_no",
      label: "Doc",
      render: (r) => (r.source_doc_no ? <span className="font-mono text-[12px]">{r.source_doc_no}</span> : "—"),
      getValue: (r) => r.source_doc_no || "",
    },
    {
      key: "narration",
      label: "Narration",
      defaultHidden: true,
      render: (r) => r.narration || "—",
      getValue: (r) => r.narration || "",
    },
    {
      key: "total_debit_sen",
      label: "Debit",
      align: "right",
      render: (r) => <span className="font-mono">{fmtCenti(r.total_debit_sen)}</span>,
      getValue: (r) => r.total_debit_sen,
    },
    {
      key: "total_credit_sen",
      label: "Credit",
      align: "right",
      render: (r) => <span className="font-mono">{fmtCenti(r.total_credit_sen)}</span>,
      getValue: (r) => r.total_credit_sen,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusPill status={jeStatus(r)} />,
      getValue: (r) => jeStatus(r),
    },
  ];

  const filtered = useMemo(() => {
    if (!rows) return rows;
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.je_no.toLowerCase().includes(q) ||
        (r.source_doc_no ?? "").toLowerCase().includes(q) ||
        (r.narration ?? "").toLowerCase().includes(q),
    );
  }, [rows, search]);

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Kpi label="Entries" value={stats.count.toLocaleString("en-MY")} />
        <Kpi label="Posted" value={stats.posted.toLocaleString("en-MY")} sub="active, non-reversed" />
        <Kpi label="Total Debit" value={fmtCenti(stats.totalDr)} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value)}
          className="h-9 rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
        >
          {SOURCE_TYPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        tableId="scm_accounting_je"
        columns={columns}
        rows={filtered}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.id}
        search={{ value: search, onChange: setSearch, placeholder: "Search JE no, doc, narration…" }}
        emptyLabel="No journal entries"
        exportName="journal-entries"
      />
    </div>
  );
}

/* ── General Ledger ──────────────────────────────────────────────────── */
function GlTab() {
  const [accountCode, setAccountCode] = useState("");
  const accounts = useQuery<{ accounts: Account[] }>(() => api.get(`${SCM}/accounting/accounts`), []);
  const list = useQuery<{ glEntries: GlEntry[] }>(
    () => api.get(`${SCM}/accounting/gl${buildQuery({ accountCode: accountCode || undefined })}`),
    [accountCode],
  );
  const rows = list.data?.glEntries ?? null;

  const columns: Column<GlEntry>[] = [
    { key: "entry_date", label: "Date", render: (r) => fmtDate(r.entry_date), getValue: (r) => r.entry_date },
    {
      key: "je_no",
      label: "JE No",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-ink">{r.je_no}</span>,
      getValue: (r) => r.je_no,
    },
    {
      key: "source",
      label: "Source",
      render: (r) => (r.source_doc_no ? `${r.source_type} · ${r.source_doc_no}` : r.source_type),
      getValue: (r) => `${r.source_type} ${r.source_doc_no ?? ""}`,
    },
    {
      key: "account",
      label: "Account",
      render: (r) => (
        <span className="text-ink">
          <span className="font-mono text-[12px] text-ink-secondary">{r.account_code}</span> — {r.account_name}
        </span>
      ),
      getValue: (r) => `${r.account_code} ${r.account_name}`,
    },
    {
      key: "debit_sen",
      label: "Debit",
      align: "right",
      render: (r) => <span className="font-mono">{r.debit_sen > 0 ? fmtCenti(r.debit_sen) : "—"}</span>,
      getValue: (r) => r.debit_sen,
    },
    {
      key: "credit_sen",
      label: "Credit",
      align: "right",
      render: (r) => <span className="font-mono">{r.credit_sen > 0 ? fmtCenti(r.credit_sen) : "—"}</span>,
      getValue: (r) => r.credit_sen,
    },
    {
      key: "party",
      label: "Party",
      render: (r) => r.party_name || r.party_code || "—",
      getValue: (r) => r.party_name || r.party_code || "",
    },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={accountCode}
          onChange={(e) => setAccountCode(e.target.value)}
          className="h-9 rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
        >
          <option value="">All accounts</option>
          {(accounts.data?.accounts ?? []).map((a) => (
            <option key={a.account_code} value={a.account_code}>
              {a.account_code} — {a.account_name}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        tableId="scm_accounting_gl"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.line_id}
        emptyLabel="No GL entries posted yet"
        exportName="general-ledger"
      />
    </div>
  );
}

/* ── Balances (trial balance) ────────────────────────────────────────── */
function BalancesTab() {
  const list = useQuery<{ balances: AccountBalance[] }>(() => api.get(`${SCM}/accounting/balances`), []);
  const rows = list.data?.balances ?? null;

  // Sort by account-type group order, then account code, so the table reads
  // like a trial balance (the 2990's version grouped with section headers;
  // a single sorted table keeps the native DataTable export + sort intact).
  const sorted = useMemo(() => {
    if (!rows) return rows;
    const rank = (t: string) => {
      const i = ACCOUNT_TYPE_ORDER.indexOf(t);
      return i === -1 ? ACCOUNT_TYPE_ORDER.length : i;
    };
    return [...rows].sort((a, b) => rank(a.account_type) - rank(b.account_type) || a.account_code.localeCompare(b.account_code));
  }, [rows]);

  const columns: Column<AccountBalance>[] = [
    {
      key: "account_type",
      label: "Type",
      render: (r) => <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">{r.account_type}</span>,
      getValue: (r) => r.account_type,
    },
    {
      key: "account",
      label: "Account",
      render: (r) => (
        <span className="text-ink">
          <span className="font-mono text-[12px] text-ink-secondary">{r.account_code}</span> — {r.account_name}
        </span>
      ),
      getValue: (r) => `${r.account_code} ${r.account_name}`,
    },
    {
      key: "total_debit_sen",
      label: "Σ Debit",
      align: "right",
      render: (r) => <span className="font-mono">{fmtCenti(r.total_debit_sen)}</span>,
      getValue: (r) => r.total_debit_sen,
    },
    {
      key: "total_credit_sen",
      label: "Σ Credit",
      align: "right",
      render: (r) => <span className="font-mono">{fmtCenti(r.total_credit_sen)}</span>,
      getValue: (r) => r.total_credit_sen,
    },
    {
      key: "balance_sen",
      label: "Balance",
      align: "right",
      render: (r) => (
        <span className={cn("font-mono font-semibold", r.balance_sen < 0 ? "text-err" : "text-ink")}>
          {fmtCenti(r.balance_sen)}
        </span>
      ),
      getValue: (r) => r.balance_sen,
    },
  ];

  return (
    <DataTable
      tableId="scm_accounting_balances"
      columns={columns}
      rows={sorted}
      loading={list.loading}
      error={list.error}
      getRowKey={(r) => r.account_code}
      emptyLabel="No balances"
      exportName="account-balances"
    />
  );
}

/* ── Aging buckets (shared by AR + AP) ───────────────────────────────── */
const BUCKETS: AgingBucket[] = ["CURRENT", "1-30", "31-60", "61-90", "90+"];

function bucketTotals<T extends { aging_bucket: AgingBucket; outstanding_centi: number }>(rows: T[]) {
  const out: Record<AgingBucket, number> = { CURRENT: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  for (const r of rows) out[r.aging_bucket] = (out[r.aging_bucket] ?? 0) + r.outstanding_centi;
  return out;
}

function BucketSummary({ totals, grandTotal }: { totals: Record<AgingBucket, number>; grandTotal: number }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {BUCKETS.map((b) => (
        <Kpi key={b} label={b} value={fmtCenti(totals[b])} />
      ))}
      <Kpi label="Total" value={fmtCenti(grandTotal)} />
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

/* ── AR Aging ────────────────────────────────────────────────────────── */
function ArAgingTab() {
  const list = useQuery<{ arAging: ArAgingRow[] }>(() => api.get(`${SCM}/accounting/ar-aging`), []);
  const rows = list.data?.arAging ?? null;
  const totals = useMemo(() => bucketTotals(rows ?? []), [rows]);
  const grand = useMemo(() => (rows ?? []).reduce((s, r) => s + r.outstanding_centi, 0), [rows]);

  const columns: Column<ArAgingRow>[] = [
    {
      key: "invoice_number",
      label: "Invoice",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-ink">{r.invoice_number}</span>,
      getValue: (r) => r.invoice_number,
    },
    {
      key: "debtor_name",
      label: "Customer",
      render: (r) => (
        <span className="text-ink">
          {r.debtor_name}
          {r.debtor_code && <span className="text-ink-muted"> ({r.debtor_code})</span>}
        </span>
      ),
      getValue: (r) => r.debtor_name,
    },
    { key: "invoice_date", label: "Date", render: (r) => fmtDate(r.invoice_date), getValue: (r) => r.invoice_date },
    { key: "due_date", label: "Due", render: (r) => fmtDate(r.due_date), getValue: (r) => r.due_date || "" },
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
      <BucketSummary totals={totals} grandTotal={grand} />
      <DataTable
        tableId="scm_accounting_ar"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.invoice_id}
        emptyLabel="No outstanding AR"
        exportName="ar-aging"
      />
    </div>
  );
}

/* ── AP Aging ────────────────────────────────────────────────────────── */
function ApAgingTab() {
  const list = useQuery<{ apAging: ApAgingRow[] }>(() => api.get(`${SCM}/accounting/ap-aging`), []);
  const rows = list.data?.apAging ?? null;
  const totals = useMemo(() => bucketTotals(rows ?? []), [rows]);
  const grand = useMemo(() => (rows ?? []).reduce((s, r) => s + r.outstanding_centi, 0), [rows]);

  const columns: Column<ApAgingRow>[] = [
    {
      key: "invoice_number",
      label: "Invoice",
      render: (r) => <span className="font-mono text-[12px] font-semibold text-ink">{r.invoice_number}</span>,
      getValue: (r) => r.invoice_number,
    },
    {
      key: "supplier_name",
      label: "Supplier",
      render: (r) => (
        <span className="text-ink">
          {r.supplier_name || "—"}
          {r.supplier_code && <span className="text-ink-muted"> ({r.supplier_code})</span>}
        </span>
      ),
      getValue: (r) => r.supplier_name || r.supplier_code || "",
    },
    { key: "invoice_date", label: "Date", render: (r) => fmtDate(r.invoice_date), getValue: (r) => r.invoice_date },
    { key: "due_date", label: "Due", render: (r) => fmtDate(r.due_date), getValue: (r) => r.due_date || "" },
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
      <BucketSummary totals={totals} grandTotal={grand} />
      <DataTable
        tableId="scm_accounting_ap"
        columns={columns}
        rows={rows}
        loading={list.loading}
        error={list.error}
        getRowKey={(r) => r.invoice_id}
        emptyLabel="No outstanding AP"
        exportName="ap-aging"
      />
    </div>
  );
}
