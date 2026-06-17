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

export interface ScmPoRow {
  id: string;
  po_number: string;
  supplier_id: string;
  supplier_name: string | null;
  status: string;
  po_date: string | null;
  expected_at: string | null;
  currency: string;
  total_centi: number;
}

interface ListResp {
  data: ScmPoRow[];
  page: number;
  per_page: number;
  total: number;
}

const FILTER_KEYS = ["search", "status", "page"] as const;
const STATUSES = ["SUBMITTED", "SCHEDULED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"];
const STATUS_TONE: Record<string, string> = {
  SUBMITTED: "bg-accent-soft/60 text-accent-ink",
  SCHEDULED: "bg-accent-soft/60 text-accent-ink",
  PARTIALLY_RECEIVED: "bg-amber-50 text-amber-700",
  RECEIVED: "bg-synced/10 text-synced",
  CANCELLED: "bg-err/10 text-err",
};

function rm(centi: number): string {
  return `RM ${(centi / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function PurchaseOrderList() {
  const navigate = useNavigate();
  const [params, setParams] = useStickyFilters("scm-po", FILTER_KEYS);
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
  const [perPage, setPerPage] = useLocalStorage<number>("pp:scm-po", 50);
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));

  const list = useQuery<ListResp>(
    () =>
      api.get(
        `/api/scm-purchase-orders${buildQuery({
          search,
          status,
          page,
          per_page: perPage,
          ...sortParams,
        })}`,
      ),
    [search, status, page, perPage, sort?.key, sort?.dir],
  );

  const columns: Column<ScmPoRow>[] = [
    {
      key: "po_number",
      label: "PO #",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.po_number}</span>,
      getValue: (r) => r.po_number,
    },
    {
      key: "supplier",
      label: "Supplier",
      alwaysVisible: true,
      render: (r) => <span className="text-ink">{r.supplier_name || "—"}</span>,
      getValue: (r) => r.supplier_name,
    },
    {
      key: "po_date",
      label: "Date",
      render: (r) => <span className="font-mono text-xs">{r.po_date || "—"}</span>,
      getValue: (r) => r.po_date,
    },
    {
      key: "expected_at",
      label: "ETA",
      render: (r) => <span className="font-mono text-xs">{r.expected_at || "—"}</span>,
      getValue: (r) => r.expected_at,
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
          {r.status.replace(/_/g, " ")}
        </span>
      ),
      getValue: (r) => r.status,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Purchase Orders"
        description="Raise and track purchase orders to your suppliers."
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
            <Button onClick={() => navigate("/scm/purchase-orders/new")} icon={<Plus size={13} />}>
              New PO
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
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        tableId="scm-po"
        exportName="scm-purchase-orders"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search PO number…",
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
        emptyLabel="No purchase orders yet — click New PO to raise one."
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/purchase-orders/${r.id}`)}
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
