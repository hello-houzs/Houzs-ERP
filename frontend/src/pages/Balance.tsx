import { useState } from "react";
import { PageHeader } from "../components/Layout";
import { FilterPills } from "../components/FilterPills";
import { DataTable, type Column } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api, buildQuery } from "../api/client";
import { cn, formatCurrency, formatDate, isExpired, isExpiringSoon } from "../lib/utils";
import type { Paginated, SalesOrder, BalanceSummary } from "../types";

type ExpiryFilter = "all" | "expired" | "warning";

export function Balance() {
  const [filter, setFilter] = useState<ExpiryFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:balance", 100);

  const list = useQuery<Paginated<SalesOrder>>(
    () =>
      api.get(
        `/api/balance${buildQuery({
          expiry_filter: filter,
          search,
          page,
          per_page: perPage,
        })}`
      ),
    [filter, search, page, perPage]
  );

  const summary = useQuery<BalanceSummary>(() => api.get("/api/balance/summary"));

  const columns: Column<SalesOrder>[] = [
    {
      key: "doc_no",
      label: "Doc No",
      alwaysVisible: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.doc_no}</span>,
      getValue: (r) => r.doc_no,
    },
    {
      key: "debtor_name",
      label: "Customer",
      render: (r) => r.debtor_name || "—",
      getValue: (r) => r.debtor_name,
    },
    {
      key: "sales_location",
      label: "Loc",
      align: "center",
      render: (r) => (
        <span className="rounded-md border border-border bg-bg px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary">
          {r.sales_location || "—"}
        </span>
      ),
      getValue: (r) => r.sales_location,
    },
    {
      key: "local_total",
      label: "Total",
      align: "right",
      render: (r) => <span className="font-mono text-xs">{formatCurrency(r.local_total)}</span>,
      getValue: (r) => r.local_total,
    },
    {
      key: "balance",
      label: "Balance",
      align: "right",
      alwaysVisible: true,
      render: (r) => (
        <span className="font-mono text-xs font-bold">{formatCurrency(r.balance)}</span>
      ),
      getValue: (r) => r.balance,
    },
    {
      key: "expiry_date",
      label: "Expiry",
      render: (r) => {
        const expired = isExpired(r.expiry_date);
        const soon = isExpiringSoon(r.expiry_date);
        return (
          <span
            className={cn(
              "font-mono text-xs",
              expired && "font-semibold text-expired-text",
              !expired && soon && "font-semibold text-warning-text"
            )}
          >
            {formatDate(r.expiry_date)}
          </span>
        );
      },
      getValue: (r) => formatDate(r.expiry_date),
    },
    {
      key: "remark4",
      label: "Status",
      render: (r) => <span className="text-xs text-ink-secondary">{r.remark4 || "—"}</span>,
      getValue: (r) => r.remark4,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Finance · Collections"
        title="Balance Collection"
        description="Orders with outstanding balance, sorted by expiry date"
      />

      {(() => {
        const s = summary.data;
        return (
          <>
            <DashboardGrid cols={4}>
              <StatCard
                label="Outstanding Total"
                value={s ? formatCurrency(s.totals.total, { compact: true }) : "—"}
                subtitle={s ? `${s.totals.count.toLocaleString()} orders` : " "}
              />
              <StatCard
                label="Expired"
                value={s ? formatCurrency(s.expired.total, { compact: true }) : "—"}
                subtitle={s ? `${s.expired.count.toLocaleString()} orders` : " "}
                tone={s && s.expired.count > 0 ? "error" : "default"}
              />
              <StatCard
                label="Expiring in 7 Days"
                value={s ? formatCurrency(s.warning.total, { compact: true }) : "—"}
                subtitle={s ? `${s.warning.count.toLocaleString()} orders` : " "}
              />
              <StatCard
                label="Healthy"
                value={
                  s
                    ? formatCurrency(
                        s.totals.total - s.expired.total - s.warning.total,
                        { compact: true }
                      )
                    : "—"
                }
                subtitle="Not yet at risk"
                tone={s ? "success" : "default"}
              />
            </DashboardGrid>

            <DashboardPanels cols={2}>
              <DashboardBreakdown
                title="By Region"
                items={
                  s?.by_region.map((r) => ({
                    label: r.region,
                    count: Math.round(r.total),
                  })) ?? []
                }
                formatCount={(n) => formatCurrency(n, { compact: true })}
              />
              <DashboardBreakdown
                title="Top 5 Debtors by Outstanding"
                items={
                  s?.top_debtors.map((d) => ({
                    label: d.name || "—",
                    count: Math.round(d.total),
                  })) ?? []
                }
                formatCount={(n) => formatCurrency(n, { compact: true })}
              />
            </DashboardPanels>
          </>
        );
      })()}

      <div className="mb-4">
        <FilterPills
          value={filter}
          onChange={(v) => {
            setPage(1);
            setFilter(v);
          }}
          options={[
            { value: "all", label: "All" },
            { value: "expired", label: "Expired" },
            { value: "warning", label: "Expiring Soon" },
          ]}
        />
      </div>

      <DataTable
        tableId="balance"
        udfTable="sales_orders"
        udfTableLabel="Sales Orders (shared)"
        exportName="balance"
        search={{
          value: search,
          onChange: (v) => {
            setPage(1);
            setSearch(v);
          },
          placeholder: "Search doc no, customer, phone…",
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading}
        error={list.error}
        emptyLabel="No outstanding balance"
        getRowKey={(r) => r.doc_no}
        getRowClassName={(r) => {
          if (isExpired(r.expiry_date)) return "bg-expired-bg/60 hover:bg-expired-bg";
          if (isExpiringSoon(r.expiry_date)) return "bg-warning-bg/60 hover:bg-warning-bg";
          return undefined;
        }}
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
