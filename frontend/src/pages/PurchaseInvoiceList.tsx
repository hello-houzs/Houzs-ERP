import { useNavigate } from "react-router-dom";
import { Plus, RefreshCw } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { api, buildQuery } from "../api/client";
import { cn } from "../lib/utils";

export interface ScmInvoiceRow {
  id: string;
  invoice_number: string;
  supplier_invoice_no: string | null;
  supplier_id: string;
  supplier_name: string | null;
  purchase_order_id: string | null;
  po_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string;
  total_centi: number;
  amount_paid_centi: number;
  status: string;
}

interface ListResp {
  data: ScmInvoiceRow[];
  page: number;
  per_page: number;
  total: number;
}

const FILTER_KEYS = ["search", "status", "page"] as const;
const STATUSES = ["UNPAID", "PARTIAL", "PAID", "CANCELLED"];
const STATUS_TONE: Record<string, string> = {
  UNPAID: "bg-amber-50 text-amber-700",
  PARTIAL: "bg-accent-soft/60 text-accent-ink",
  PAID: "bg-synced/10 text-synced",
  CANCELLED: "bg-bg text-ink-muted",
};

function rm(centi: number): string {
  return `RM ${(centi / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function PurchaseInvoiceList() {
  const navigate = useNavigate();
  const [params, setParams] = useStickyFilters("scm-pi", FILTER_KEYS);
  const search = params.get("search") || "";
  const status = params.get("status") || "";
  const page = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);

  function patch(p: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(p)) {
      if (v === "" || (k === "page" && v === "1")) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }
  const setSearch = (v: string) => patch({ search: v, page: "1" });
  const setPage = (n: number) => patch({ page: String(n) });
  const [perPage, setPerPage] = useLocalStorage<number>("pp:scm-pi", 50);
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));

  const list = useQuery<ListResp>(
    () =>
      api.get(
        `/api/scm-purchase-invoices${buildQuery({
          search,
          status,
          page,
          per_page: perPage,
          ...sortParams,
        })}`,
      ),
    [search, status, page, perPage, sort?.key, sort?.dir],
  );

  const columns: Column<ScmInvoiceRow>[] = [
    {
      key: "invoice_number",
      label: "Invoice #",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.invoice_number}</span>,
      getValue: (r) => r.invoice_number,
    },
    {
      key: "supplier_invoice_no",
      label: "Supplier ref",
      render: (r) => <span className="font-mono text-xs">{r.supplier_invoice_no || "—"}</span>,
      getValue: (r) => r.supplier_invoice_no,
    },
    {
      key: "supplier",
      label: "Supplier",
      alwaysVisible: true,
      render: (r) => <span className="text-ink">{r.supplier_name || "—"}</span>,
      getValue: (r) => r.supplier_name,
    },
    {
      key: "po_number",
      label: "PO #",
      render: (r) => <span className="font-mono text-xs">{r.po_number || "—"}</span>,
      getValue: (r) => r.po_number,
    },
    {
      key: "invoice_date",
      label: "Date",
      render: (r) => <span className="font-mono text-xs">{r.invoice_date || "—"}</span>,
      getValue: (r) => r.invoice_date,
    },
    {
      key: "due_date",
      label: "Due",
      render: (r) => <span className="font-mono text-xs">{r.due_date || "—"}</span>,
      getValue: (r) => r.due_date,
    },
    {
      key: "total",
      label: "Total",
      align: "right",
      render: (r) => <span className="font-mono text-xs font-semibold">{rm(r.total_centi)}</span>,
      getValue: (r) => r.total_centi,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            STATUS_TONE[r.status] || "bg-bg text-ink-muted",
          )}
        >
          {r.status}
        </span>
      ),
      getValue: (r) => r.status,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Purchase Invoices"
        description="Record supplier bills and track what's paid."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<RefreshCw size={13} className={list.loading ? "animate-spin" : ""} />}
              onClick={() => list.reload()}
              disabled={list.loading}
            >
              Refresh
            </Button>
            <Button onClick={() => navigate("/scm/purchase-invoices/new")} icon={<Plus size={13} />}>
              New Invoice
            </Button>
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={status}
          onChange={(e) => patch({ status: e.target.value, page: "1" })}
          className="rounded border border-border bg-paper px-2 py-1 text-[12px]"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        tableId="scm-pi"
        exportName="scm-purchase-invoices"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search invoice or supplier ref…",
        }}
        resetFilters={{
          active: !!(search || status),
          onReset: () => {
            const next = new URLSearchParams(params);
            FILTER_KEYS.forEach((k) => next.delete(k));
            setParams(next, { replace: true });
          },
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No purchase invoices yet — click New Invoice to record one."
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/purchase-invoices/${r.id}`)}
        serverSort
        onSortChange={handleSortChange}
      />

      {list.data && (
        <Pagination
          page={page}
          perPage={perPage}
          total={list.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
        />
      )}
    </div>
  );
}
