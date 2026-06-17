import { useNavigate } from "react-router-dom";
import { Plus, RefreshCw, ArrowRight } from "lucide-react";
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

export interface ScmTransferRow {
  id: string;
  transfer_number: string;
  from_warehouse_code: string;
  to_warehouse_code: string;
  status: string;
  created_at: string | null;
}

interface ListResp {
  data: ScmTransferRow[];
  page: number;
  per_page: number;
  total: number;
}

const FILTER_KEYS = ["search", "status", "page"] as const;
const STATUSES = ["DRAFT", "POSTED", "CANCELLED"];
const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-bg text-ink-muted",
  POSTED: "bg-synced/10 text-synced",
  CANCELLED: "bg-err/10 text-err",
};

export function StockTransferList() {
  const navigate = useNavigate();
  const [params, setParams] = useStickyFilters("scm-trf", FILTER_KEYS);
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
  const [perPage, setPerPage] = useLocalStorage<number>("pp:scm-trf", 50);
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));

  const list = useQuery<ListResp>(
    () =>
      api.get(
        `/api/scm-stock-transfers${buildQuery({
          search,
          status,
          page,
          per_page: perPage,
          ...sortParams,
        })}`,
      ),
    [search, status, page, perPage, sort?.key, sort?.dir],
  );

  const columns: Column<ScmTransferRow>[] = [
    {
      key: "transfer_number",
      label: "Transfer #",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.transfer_number}</span>,
      getValue: (r) => r.transfer_number,
    },
    {
      key: "route",
      label: "From / To",
      alwaysVisible: true,
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 font-mono text-xs">
          {r.from_warehouse_code}
          <ArrowRight size={12} className="text-ink-muted" />
          {r.to_warehouse_code}
        </span>
      ),
      getValue: (r) => `${r.from_warehouse_code} ${r.to_warehouse_code}`,
    },
    {
      key: "created_at",
      label: "Created",
      render: (r) => (
        <span className="font-mono text-xs">{r.created_at ? r.created_at.slice(0, 10) : "—"}</span>
      ),
      getValue: (r) => r.created_at,
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
        title="Stock Transfers"
        description="Move on-hand stock between warehouses."
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
            <Button onClick={() => navigate("/scm/transfers/new")} icon={<Plus size={13} />}>
              New Transfer
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
        tableId="scm-trf"
        exportName="scm-stock-transfers"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search transfer number…",
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
        emptyLabel="No stock transfers yet — click New Transfer to move stock between warehouses."
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/transfers/${r.id}`)}
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
