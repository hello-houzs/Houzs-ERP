import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { FilterPills } from "../components/FilterPills";
import { DataTable } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useServerSort } from "../hooks/useServerSort";
import { api, buildQuery } from "../api/client";
import { formatCurrency } from "../lib/utils";
import { getSalesOrderColumns } from "../lib/orderColumns";
import type { Paginated, SalesOrder, Region, OrdersSummary } from "../types";

type RegionFilter = "ALL" | Region;

export function DeliveryOrders() {
  const navigate = useNavigate();
  const [region, setRegion] = useState<RegionFilter>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:delivery-orders", 50);

  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));

  const list = useQuery<Paginated<SalesOrder>>(
    () =>
      api.get(
        `/api/orders${buildQuery({
          view: "do",
          region: region === "ALL" ? undefined : region,
          search,
          page,
          per_page: perPage,
          ...sortParams,
        })}`
      ),
    [region, search, page, perPage, sort?.key, sort?.dir]
  );

  const summary = useQuery<OrdersSummary>(() => api.get("/api/orders/summary"));

  // Same column set as Sales Orders — both views read the same D1 sales_orders
  // table, so the column count, identifiers, and CSV shape stay aligned. Users
  // can hide the columns they don't want via the column chooser; choices
  // persist per page in localStorage.
  const columns = getSalesOrderColumns();

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Logistics"
        title="Delivery Orders"
        description="Sales orders ready for delivery scheduling"
      />

      {(() => {
        const d = summary.data?.delivery;
        const all = summary.data?.all;
        const ratio = d && all && all.total > 0 ? Math.round((d.total / all.total) * 100) : 0;
        const statusEntries = d
          ? Object.entries(d.by_status).sort((a, b) => b[1] - a[1]).slice(0, 6)
          : [];
        return (
          <>
            <DashboardGrid cols={4}>
              <StatCard
                label="Ready to Schedule"
                value={d ? d.total.toLocaleString() : "—"}
                subtitle={d && all ? `${ratio}% of all orders` : " "}
              />
              <StatCard
                label="Expiring in 7 Days"
                value={d ? d.expiring_7d.toLocaleString() : "—"}
                subtitle="Action required soon"
                tone={d && d.expiring_7d > 0 ? "error" : "default"}
              />
              <StatCard
                label="Already Expired"
                value={d ? d.expired.toLocaleString() : "—"}
                subtitle="Past SalesExemptionExpiryDate"
                tone={d && d.expired > 0 ? "error" : "default"}
              />
              <StatCard
                label="Outstanding"
                value={d ? formatCurrency(d.total_balance, { compact: true }) : "—"}
                subtitle={d ? `${d.outstanding_count.toLocaleString()} with balance` : " "}
              />
            </DashboardGrid>

            <DashboardPanels cols={2}>
              <DashboardBreakdown
                title="By Region"
                items={
                  d
                    ? (["WEST", "EAST", "SG", "OTHER"] as const).map((k) => ({
                        label: k === "OTHER" ? "Other" : k,
                        count: d.by_region[k] ?? 0,
                      }))
                    : []
                }
              />
              <DashboardBreakdown
                title="By Delivery Message Status (Top 6)"
                items={statusEntries.map(([k, v]) => ({ label: k, count: v }))}
              />
            </DashboardPanels>
          </>
        );
      })()}

      <div className="mb-4">
        <FilterPills
          value={region}
          onChange={(v) => {
            setPage(1);
            setRegion(v);
          }}
          options={[
            { value: "ALL", label: "All" },
            { value: "WEST", label: "West" },
            { value: "EAST", label: "East" },
            { value: "SG", label: "SG" },
          ]}
        />
      </div>

      <DataTable
        tableId="delivery-orders"
        udfTable="sales_orders"
        udfTableLabel="Sales Orders (shared)"
        exportName="delivery-orders"
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
        emptyLabel="No delivery orders"
        getRowKey={(r) => r.doc_no}
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
    </div>
  );
}
