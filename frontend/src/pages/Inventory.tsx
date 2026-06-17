import { RefreshCw } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { api, buildQuery } from "../api/client";

interface OnHandRow {
  warehouse_code: string;
  material_kind: string;
  material_code: string;
  material_name: string | null;
  qty_on_hand: number;
  value_centi: number;
  avg_cost_centi: number;
}

interface ListResp {
  data: OnHandRow[];
  page: number;
  per_page: number;
  total: number;
}

interface Warehouse {
  code: string;
  name: string;
}

const FILTER_KEYS = ["search", "warehouse", "material_kind", "page"] as const;
const KINDS = ["mfg_product", "fabric", "raw"];

function rm(centi: number): string {
  return `RM ${(centi / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function Inventory() {
  const [params, setParams] = useStickyFilters("scm-inventory", FILTER_KEYS);
  const search = params.get("search") || "";
  const warehouse = params.get("warehouse") || "";
  const materialKind = params.get("material_kind") || "";
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
  const [perPage, setPerPage] = useLocalStorage<number>("pp:scm-inventory", 50);

  const warehouses = useQuery<{ data: Warehouse[] }>(() => api.get("/api/warehouses"), []);

  const list = useQuery<ListResp>(
    () =>
      api.get(
        `/api/scm-inventory${buildQuery({
          search,
          warehouse_code: warehouse,
          material_kind: materialKind,
          page,
          per_page: perPage,
        })}`,
      ),
    [search, warehouse, materialKind, page, perPage],
  );

  const columns: Column<OnHandRow>[] = [
    {
      key: "warehouse_code",
      label: "Warehouse",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.warehouse_code}</span>,
      getValue: (r) => r.warehouse_code,
    },
    {
      key: "material",
      label: "Material",
      alwaysVisible: true,
      render: (r) => (
        <div>
          <div className="font-mono text-xs font-medium text-ink">{r.material_code}</div>
          {r.material_name && <div className="text-[11px] text-ink-muted">{r.material_name}</div>}
        </div>
      ),
      getValue: (r) => `${r.material_code} ${r.material_name || ""}`.trim(),
    },
    {
      key: "material_kind",
      label: "Kind",
      render: (r) => <span className="text-xs">{r.material_kind}</span>,
      getValue: (r) => r.material_kind,
    },
    {
      key: "qty_on_hand",
      label: "On hand",
      align: "right",
      render: (r) => <span className="font-mono text-xs font-semibold">{r.qty_on_hand}</span>,
      getValue: (r) => r.qty_on_hand,
    },
    {
      key: "avg_cost_centi",
      label: "Avg cost",
      align: "right",
      render: (r) => <span className="font-mono text-xs">{rm(r.avg_cost_centi)}</span>,
      getValue: (r) => r.avg_cost_centi,
    },
    {
      key: "value_centi",
      label: "Value",
      align: "right",
      render: (r) => <span className="font-mono text-xs font-semibold">{rm(r.value_centi)}</span>,
      getValue: (r) => r.value_centi,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Supply Chain"
        title="Inventory"
        description="Stock on hand and valuation (FIFO) across warehouses, derived from the movement ledger."
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw size={13} className={list.loading ? "animate-spin" : ""} />}
            onClick={() => list.reload()}
            disabled={list.loading}
          >
            Refresh
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={warehouse}
          onChange={(e) => patch({ warehouse: e.target.value, page: "1" })}
          className="rounded border border-border bg-paper px-2 py-1 text-[12px]"
        >
          <option value="">All warehouses</option>
          {(warehouses.data?.data ?? []).map((w) => (
            <option key={w.code} value={w.code}>
              {w.code} — {w.name}
            </option>
          ))}
        </select>
        <select
          value={materialKind}
          onChange={(e) => patch({ material_kind: e.target.value, page: "1" })}
          className="rounded border border-border bg-paper px-2 py-1 text-[12px]"
        >
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        tableId="scm-inventory"
        exportName="scm-inventory"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search material code or name…",
        }}
        resetFilters={{
          active: !!(search || warehouse || materialKind),
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
        emptyLabel="No stock movements yet."
        getRowKey={(r) => `${r.warehouse_code}-${r.material_kind}-${r.material_code}`}
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
