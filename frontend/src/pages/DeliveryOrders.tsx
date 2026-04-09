import { useState } from "react";
import { PageHeader } from "../components/Layout";
import { FilterPills } from "../components/FilterPills";
import { DataTable } from "../components/DataTable";
import { Pagination } from "../components/Pagination";
import { Panel, PanelSection, FieldRow } from "../components/Panel";
import { InlineEdit } from "../components/InlineEdit";
import { StatCard } from "../components/StatCard";
import { DashboardGrid, DashboardPanels, DashboardBreakdown } from "../components/Dashboard";
import { useQuery } from "../hooks/useQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { api, buildQuery } from "../api/client";
import { formatCurrency, formatDate, cn } from "../lib/utils";
import { getSalesOrderColumns } from "../lib/orderColumns";
import type { Paginated, SalesOrder, OrderDetails, Region, OrdersSummary } from "../types";

type RegionFilter = "ALL" | Region;

// Same option list used by the Sales Orders page — kept here so updates flow
// to both dropdowns. If this list grows, lift it into a shared module.
const DELIVERY_MESSAGE_STATUSES = [
  "to send delivery date",
  "pending customer reply (D)",
  "pending reschedule (D)",
  "done scheduling",
  "not sent (D)",
  "Pending Reschedule (A)",
  "Not sent (A)",
] as const;

export function DeliveryOrders() {
  const [region, setRegion] = useState<RegionFilter>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useLocalStorage<number>("pp:delivery-orders", 50);
  const [selected, setSelected] = useState<SalesOrder | null>(null);

  const list = useQuery<Paginated<SalesOrder>>(
    () =>
      api.get(
        `/api/orders${buildQuery({
          view: "do",
          region: region === "ALL" ? undefined : region,
          search,
          page,
          per_page: perPage,
        })}`
      ),
    [region, search, page, perPage]
  );

  const summary = useQuery<OrdersSummary>(() => api.get("/api/orders/summary"));

  const detail = useQuery<{ order: SalesOrder; details: OrderDetails | null }>(
    () =>
      selected
        ? api.get(`/api/orders/${encodeURIComponent(selected.doc_no)}`)
        : Promise.resolve({ order: null as any, details: null }),
    [selected?.doc_no]
  );

  async function patchOrder(docNo: string, body: Record<string, any>) {
    const res: any = await api.patch(`/api/orders/${encodeURIComponent(docNo)}`, body);
    if (res?.sync_status === "ERROR") {
      throw new Error(res.sync_error || "Push failed");
    }
    list.reload();
    detail.reload();
  }

  // Same column set as Sales Orders — both views read the same D1 sales_orders
  // table, so the column count, identifiers, and CSV shape stay aligned. Users
  // can hide the columns they don't want via the column chooser; choices
  // persist per page in localStorage.
  const columns = getSalesOrderColumns();

  const order = detail.data?.order ?? selected;

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
        onRowClick={(r) => setSelected(r)}
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

      <Panel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.doc_no || ""}
        subtitle={selected?.debtor_name || ""}
      >
        {order && (
          <>
            <PanelSection title="Order" muted>
              <FieldRow label="Doc No" mono>
                {order.doc_no}
              </FieldRow>
              <FieldRow label="D/O">{order.transfer_to || "—"}</FieldRow>
              <FieldRow label="Date">{formatDate(order.doc_date)}</FieldRow>
              <FieldRow label="Customer">{order.debtor_name || "—"}</FieldRow>
              <FieldRow label="Phone" mono>
                {order.phone || "—"}
              </FieldRow>
              <FieldRow label="Loc">{order.sales_location || "—"}</FieldRow>
              <FieldRow label="Agent">{order.sales_agent || "—"}</FieldRow>
              <FieldRow label="Balance" mono>
                <span className={cn(order.balance > 0 && "font-semibold text-err")}>
                  {formatCurrency(order.balance)}
                </span>
              </FieldRow>
            </PanelSection>

            <PanelSection title="Delivery (auto-pushed)">
              <InlineEdit
                label="Delivery Message Status"
                value={order.remark4}
                options={DELIVERY_MESSAGE_STATUSES}
                onSave={(v) => patchOrder(order.doc_no, { remark4: v })}
              />
              <InlineEdit
                label="Expiry Date"
                type="date"
                value={order.expiry_date}
                onSave={(v) => patchOrder(order.doc_no, { expiry_date: v })}
              />
            </PanelSection>

            <PanelSection title="Address" muted>
              <div className="space-y-1 text-sm text-ink-secondary">
                <div>{order.inv_addr1 || "—"}</div>
                <div>{order.inv_addr2 || ""}</div>
                <div>{order.inv_addr3 || ""}</div>
                <div>{order.inv_addr4 || ""}</div>
              </div>
            </PanelSection>

            <PanelSection title="Notes" muted>
              <FieldRow label="Remark 2">{order.remark2 || "—"}</FieldRow>
              <FieldRow label="Remark 3">{order.remark3 || "—"}</FieldRow>
              <FieldRow label="Note">{order.note || "—"}</FieldRow>
            </PanelSection>
          </>
        )}
      </Panel>
    </div>
  );
}
