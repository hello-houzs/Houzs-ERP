import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { FilterPills } from "../components/FilterPills";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { api, buildQuery } from "../api/client";
import { formatCurrency } from "../lib/utils";
import { getSalesOrderColumns } from "../lib/orderColumns";
import type { SalesOrder, Region } from "../types";

type RegionFilter = "ALL" | Region;

const VIEW_KEYS = ["region", "search", "page"] as const;

interface FlatItemRow extends SalesOrder {
  item_line_no: number | null;
  item_code: string | null;
  item_description: string | null;
  item_uom: string | null;
  item_qty: number | null;
  item_unit_price: number | null;
  item_amount: number | null;
}

interface FlatItemsResponse {
  data: FlatItemRow[];
  page: number;
  per_page: number;
  total: number;
  total_items: number;
  fetch_errors: Array<{ doc_no: string; error: string }>;
}

export function SalesOrderItems() {
  const navigate = useNavigate();
  const [params, setParams] = useStickyFilters("sales-order-items", VIEW_KEYS);
  const region = ((params.get("region") || "ALL") as RegionFilter);
  const search = params.get("search") || "";
  const page = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);

  function patchParams(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "" || (k === "region" && v === "ALL") || (k === "page" && v === "1"))
        next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }
  const setRegion = (v: RegionFilter) => patchParams({ region: v, page: "1" });
  const setSearch = (v: string) => patchParams({ search: v, page: "1" });
  const setPage = (n: number) => patchParams({ page: String(n) });

  const [perPage, setPerPage] = useLocalStorage<number>("pp:sales-order-items", 25);
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));

  const list = useQuery<FlatItemsResponse>(
    () =>
      api.get(
        `/api/orders/items${buildQuery({
          region: region === "ALL" ? undefined : region,
          search,
          page,
          per_page: perPage,
          ...sortParams,
        })}`
      ),
    [region, search, page, perPage, sort?.key, sort?.dir]
  );

  // Build columns: SO/Item leading column, item-level columns, then the
  // standard sales-order column set minus doc_no (already in the leader).
  const columns = useMemo<Column<FlatItemRow>[]>(() => {
    const soCols = getSalesOrderColumns().filter((c) => c.key !== "doc_no");

    const itemCols: Column<FlatItemRow>[] = [
      {
        key: "so_item",
        label: "SO / Item",
        alwaysVisible: true,
        render: (r) => (
          <div className="leading-tight">
            <div className="font-mono text-xs font-medium">{r.doc_no}</div>
            <div className="font-mono text-[11px] text-ink-secondary">
              {r.item_code || "—"}
            </div>
          </div>
        ),
        getValue: (r) => `${r.doc_no} / ${r.item_code || ""}`,
      },
      {
        key: "item_description",
        label: "Description",
        render: (r) => (
          <span className="block truncate" style={{ maxWidth: 280 }}>
            {r.item_description || "—"}
          </span>
        ),
        getValue: (r) => r.item_description,
      },
      {
        key: "item_uom",
        label: "UOM",
        align: "center",
        render: (r) => <span className="text-xs">{r.item_uom || "—"}</span>,
        getValue: (r) => r.item_uom,
      },
      {
        key: "item_qty",
        label: "Qty",
        align: "right",
        render: (r) => (
          <span className="font-mono text-xs">
            {r.item_qty == null ? "—" : r.item_qty}
          </span>
        ),
        getValue: (r) => r.item_qty,
      },
      {
        key: "item_unit_price",
        label: "Unit Price",
        align: "right",
        render: (r) => (
          <span className="font-mono text-xs">
            {r.item_unit_price == null ? "—" : formatCurrency(r.item_unit_price)}
          </span>
        ),
        getValue: (r) => r.item_unit_price,
      },
      {
        key: "item_amount",
        label: "Line Amount",
        align: "right",
        render: (r) => (
          <span className="font-mono text-xs">
            {r.item_amount == null ? "—" : formatCurrency(r.item_amount)}
          </span>
        ),
        getValue: (r) => r.item_amount,
      },
    ];

    return [...itemCols, ...(soCols as unknown as Column<FlatItemRow>[])];
  }, []);

  const fetchErrors = list.data?.fetch_errors ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Operations · Sales"
        title="Sales Order Detail"
        description={
          list.data
            ? `${list.data.total_items.toLocaleString()} item rows on this page`
            : "One row per line item across sales orders"
        }
      />

      {fetchErrors.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-warning-text/30 bg-warning-bg px-3 py-2 text-xs text-warning-text">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">
              {fetchErrors.length} order(s) failed to load items
            </div>
            <div className="mt-0.5 font-mono text-[11px] opacity-80">
              {fetchErrors.slice(0, 5).map((e) => e.doc_no).join(", ")}
              {fetchErrors.length > 5 && ` +${fetchErrors.length - 5} more`}
            </div>
          </div>
        </div>
      )}

      <div className="mb-4">
        <FilterPills
          value={region}
          onChange={(v) => setRegion(v)}
          options={[
            { value: "ALL", label: "All" },
            { value: "WEST", label: "West" },
            { value: "EAST", label: "East" },
            { value: "SG", label: "SG" },
          ]}
        />
      </div>

      <DataTable
        tableId="sales-order-items"
        udfTable="sales_orders"
        udfTableLabel="Sales Orders"
        exportName="sales-order-items"
        search={{
          value: search,
          onChange: (v) => setSearch(v),
          placeholder: "Search doc no, customer, phone…",
        }}
        resetFilters={{
          active: !!(search || region !== "ALL"),
          onReset: () => {
            const next = new URLSearchParams(params);
            ["search", "region", "page"].forEach((k) => next.delete(k));
            setParams(next, { replace: true });
          },
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No items found"
        getRowKey={(r) =>
          `${r.doc_no}::${r.item_line_no ?? "x"}::${r.item_code ?? ""}`
        }
        onRowClick={(r) => navigate(`/orders/${encodeURIComponent(r.doc_no)}`)}
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
    </>
  );
}
