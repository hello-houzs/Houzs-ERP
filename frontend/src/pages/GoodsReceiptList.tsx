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

export interface ScmGrnRow {
  id: string;
  grn_number: string;
  supplier_id: string;
  supplier_name: string | null;
  purchase_order_id: string | null;
  po_number: string | null;
  warehouse_code: string;
  status: string;
  received_date: string | null;
}

interface ListResp {
  data: ScmGrnRow[];
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

export function GoodsReceiptList() {
  const navigate = useNavigate();
  const [params, setParams] = useStickyFilters("scm-grn", FILTER_KEYS);
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
  const [perPage, setPerPage] = useLocalStorage<number>("pp:scm-grn", 50);
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));

  const list = useQuery<ListResp>(
    () =>
      api.get(
        `/api/scm-goods-receipts${buildQuery({
          search,
          status,
          page,
          per_page: perPage,
          ...sortParams,
        })}`,
      ),
    [search, status, page, perPage, sort?.key, sort?.dir],
  );

  const columns: Column<ScmGrnRow>[] = [
    {
      key: "grn_number",
      label: "GRN #",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.grn_number}</span>,
      getValue: (r) => r.grn_number,
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
      key: "warehouse_code",
      label: "Warehouse",
      render: (r) => <span className="font-mono text-xs">{r.warehouse_code}</span>,
      getValue: (r) => r.warehouse_code,
    },
    {
      key: "received_date",
      label: "Received",
      render: (r) => <span className="font-mono text-xs">{r.received_date || "—"}</span>,
      getValue: (r) => r.received_date,
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
        title="Goods Receipts"
        description="Receive purchase-order deliveries into stock."
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
            <Button onClick={() => navigate("/scm/goods-receipts/new")} icon={<Plus size={13} />}>
              New GRN
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
        tableId="scm-grn"
        exportName="scm-goods-receipts"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search GRN number…",
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
        emptyLabel="No goods receipts yet — click New GRN to receive a delivery."
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/scm/goods-receipts/${r.id}`)}
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
