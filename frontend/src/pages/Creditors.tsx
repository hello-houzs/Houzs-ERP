import { useNavigate } from "react-router-dom";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { api, buildQuery } from "../api/client";
import { formatCurrency } from "../lib/utils";
import type { Paginated, Creditor, CreditorSummary } from "../types";

// Prefixed URL keys (`c_*`) so when CreditorsTab is mounted inside the
// PurchaseOrders tabbed page, its filters don't collide with the parent
// PO list's `search` / `page` keys.
const CREDITORS_FILTER_KEYS = ["c_search", "c_page"] as const;

/**
 * CreditorsTab — embeds inside the PurchaseOrders page as one tab.
 * Read-only mirror of AutoCount /Creditor/getAll. Distinct from
 * /suppliers (local service/3PL suppliers). The parent page owns the
 * Refresh button and triggers reload via the `refreshKey` prop.
 *
 * Row click navigates to /creditors/:code (dedicated detail page).
 */

export function CreditorsTab({ refreshKey = 0 }: { refreshKey?: number }) {
  const [params, setParams] = useStickyFilters("creditors", CREDITORS_FILTER_KEYS);
  const search = params.get("c_search") || "";
  const page = Math.max(1, parseInt(params.get("c_page") || "1", 10) || 1);
  function patchParams(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "" || (k === "c_page" && v === "1")) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }
  const setSearch = (v: string) => patchParams({ c_search: v, c_page: "1" });
  const setPage = (n: number) => patchParams({ c_page: String(n) });

  const [perPage, setPerPage] = useLocalStorage<number>("pp:creditors", 50);
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));
  const navigate = useNavigate();

  const list = useQuery<Paginated<Creditor>>(
    () =>
      api.get(
        `/api/creditors${buildQuery({
          search,
          page,
          per_page: perPage,
          ...sortParams,
        })}`
      ),
    [search, page, perPage, sort?.key, sort?.dir, refreshKey]
  );

  const summary = useQuery<CreditorSummary>(
    () => api.get("/api/creditors/summary"),
    [refreshKey]
  );

  const columns: Column<Creditor>[] = [
    {
      key: "creditor_code",
      label: "Code",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.creditor_code}</span>,
      getValue: (r) => r.creditor_code,
    },
    {
      key: "company_name",
      label: "Name",
      alwaysVisible: true,
      render: (r) => (
        <div>
          <div className="font-medium text-ink">{r.company_name || "—"}</div>
          {r.desc2 && r.desc2 !== r.company_name && (
            <div className="text-[11px] text-ink-muted">{r.desc2}</div>
          )}
        </div>
      ),
      getValue: (r) => r.company_name,
    },
    {
      key: "contact",
      label: "Contact",
      render: (r) => (
        <div className="text-xs">
          {r.email && <div>{r.email}</div>}
          {r.phone1 && <div className="text-ink-muted">{r.phone1}</div>}
          {!r.email && !r.phone1 && <span className="text-ink-muted">—</span>}
        </div>
      ),
      getValue: (r) => `${r.email || ""} ${r.phone1 || ""}`.trim(),
    },
    {
      key: "currency",
      label: "Curr",
      render: (r) => <span className="text-xs">{r.currency_code || "—"}</span>,
      getValue: (r) => r.currency_code,
    },
    {
      key: "po_count",
      label: "POs",
      align: "right",
      render: (r) => (
        <span className="font-mono text-xs">
          {(r.po_count ?? 0).toLocaleString()}
          {(r.open_po_count ?? 0) > 0 && (
            <span className="ml-1 text-amber-700">({r.open_po_count} open)</span>
          )}
        </span>
      ),
      getValue: (r) => r.po_count ?? 0,
    },
    {
      key: "total_spend",
      label: "Spend (RM)",
      align: "right",
      render: (r) => (
        <span className="font-mono text-xs font-semibold">
          {formatCurrency(r.total_local_ex_tax ?? 0, { compact: true })}
        </span>
      ),
      getValue: (r) => r.total_local_ex_tax ?? 0,
    },
    {
      key: "type",
      label: "Type",
      render: (r) => <span className="text-xs">{r.type_description || r.type || "—"}</span>,
      getValue: (r) => r.type_description || r.type,
    },
    {
      key: "purchase_agent",
      label: "Agent",
      render: (r) => (
        <span className="text-xs">
          {r.purchase_agent_description || r.purchase_agent || "—"}
        </span>
      ),
      getValue: (r) => r.purchase_agent_description || r.purchase_agent,
    },
  ];

  return (
    <div>
      {(() => {
        const s = summary.data;
        return (
          <>
            <DashboardGrid cols={3}>
              <StatCard
                label="Total Creditors"
                value={s ? s.totals.total.toLocaleString() : "—"}
                subtitle="Mirrored from AutoCount"
              />
              <StatCard
                label="Currencies"
                value={s ? s.totals.currency_count.toLocaleString() : "—"}
                subtitle={s ? `${s.totals.type_count} types` : "Loading…"}
              />
              <StatCard
                label="Top Spend"
                value={
                  s && s.top_by_spend[0]
                    ? formatCurrency(s.top_by_spend[0].total_spend, { compact: true })
                    : "—"
                }
                subtitle={
                  s && s.top_by_spend[0] ? s.top_by_spend[0].creditor_name : "Loading…"
                }
              />
            </DashboardGrid>

            <DashboardPanels cols={1}>
              <DashboardBreakdown
                title="Top Creditors by Spend"
                items={
                  s?.top_by_spend.map((t) => ({
                    label: t.creditor_name,
                    count: t.po_count,
                  })) ?? []
                }
              />
            </DashboardPanels>
          </>
        );
      })()}

      <DataTable
        tableId="creditors"
        exportName="creditors"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search code, name, email, phone…",
        }}
        resetFilters={{
          active: !!search,
          onReset: () => {
            const next = new URLSearchParams(params);
            ["c_search", "c_page"].forEach((k) => next.delete(k));
            setParams(next, { replace: true });
          },
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No creditors yet — hit Refresh to pull from AutoCount"
        getRowKey={(r) => r.creditor_code}
        onRowClick={(r) => navigate(`/creditors/${encodeURIComponent(r.creditor_code)}`)}
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
